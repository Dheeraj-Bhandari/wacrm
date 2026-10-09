# EC2 deploy (GitHub Actions → Docker Hub → EC2 via OIDC + SSM)

This describes the automated pipeline in `.github/workflows/deploy-ec2.yml`.
On every push to `main` (or a manual run) it:

1. Builds the Next.js Docker image and pushes it to your **private** Docker Hub
   repo with two tags:
   - `prod_<DD_MON_YYYY>-<short-sha>` — immutable, traceable (e.g.
     `prod_09_OCT_2026-ab12cd3`)
   - `prod` — rolling tag the compose file pulls by default
2. Assumes an AWS IAM role via **OIDC** (no long-lived AWS keys in GitHub).
3. Uses **SSM Run Command** to drive the EC2 box — no SSH key, no open port 22.
   On the box it refreshes `docker-compose.prod.yml`, logs in to Docker Hub,
   `docker compose pull` + `up -d` the new immutable tag, then
   `docker image prune -af` to keep the 28 GB disk from filling up.

Why SSM instead of SSH: your instance already has an IAM role
(`opencrm-instance-role`). SSM lets GitHub (authenticated by OIDC) run commands
through the AWS control plane, so there are no SSH keys to rotate and the
security group needs no inbound 22.

---

## One-time setup

### 1. EC2 box prerequisites

- **SSM Agent** — preinstalled on Ubuntu AWS AMIs. Verify:
  `sudo snap services amazon-ssm-agent` (or `sudo systemctl status amazon-ssm-agent`).
- **Instance role can talk to SSM** — attach the AWS-managed policy
  `AmazonSSMManagedInstanceCore` to `opencrm-instance-role`. After attaching,
  the instance should appear under *Systems Manager → Fleet Manager* as
  *Managed*.
- **Compose dir** — the workflow uses `/home/ubuntu/wacrm`. It already exists
  on your box. `.env.prod` (runtime secrets) must live there; it is **not**
  managed by CI (secrets stay on the host). The workflow overwrites
  `docker-compose.prod.yml` in that dir on each deploy, so don't hand-edit it.
- **Docker + compose plugin** — already installed (you're running it).
- **Docker Hub login** — already configured on the box, so CI does not log in
  remotely. One caveat: SSM runs the deploy as **root**, so the stored
  credential must be readable by root. If you ran `docker login` as the
  `ubuntu` user, make it available to root once:

  ```bash
  sudo mkdir -p /root/.docker && sudo cp ~/.docker/config.json /root/.docker/config.json
  ```

  (Or just re-run `sudo docker login` once.) If the image stays public you can
  skip this entirely.

> Note: SSM Run Command executes as `root`. The script `cd`s into
> `/home/ubuntu/wacrm` and runs `docker` as root against the root-owned Docker
> socket, which is correct. `.env.prod` is read by compose, not by the shell,
> so its ownership doesn't matter as long as root can read it.

### 2. AWS OIDC role for GitHub Actions

This lets GitHub Actions assume an AWS role using a short-lived OIDC token — no
AWS access keys stored in GitHub. Two pieces: an **identity provider** (tells
AWS to trust GitHub's token issuer) and a **role** (what GitHub is allowed to
do). The values below are already filled in for account `061051243529` and repo
`Dheeraj-Bhandari/wacrm`.

#### 2a. Create the GitHub OIDC identity provider (once per AWS account)

**Console:** IAM → Identity providers → *Add provider* → **OpenID Connect**:

- Provider URL: `https://token.actions.githubusercontent.com`
  (click *Get thumbprint*)
- Audience: `sts.amazonaws.com`

**Or CLI:**

```bash
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com
```

If it already exists you'll get `EntityAlreadyExists` — that's fine, skip to 2b.
The resulting provider ARN is:
`arn:aws:iam::061051243529:oidc-provider/token.actions.githubusercontent.com`

#### 2b. Create the role with a trust policy

Create a role (e.g. `wacrm-github-deploy`) trusting that provider, scoped to
your repo. The `sub` condition restricts it to the `main` branch of your repo
so no other repo or branch can assume it.

Save this as `trust-policy.json`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::061051243529:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": "repo:Dheeraj-Bhandari/wacrm:ref:refs/heads/main"
        }
      }
    }
  ]
}
```

> To also allow manual `workflow_dispatch` runs from other branches, broaden the
> `sub` to `repo:Dheeraj-Bhandari/wacrm:*`. The branch-pinned value above is the
> tighter, recommended default.

Create the role:

```bash
aws iam create-role \
  --role-name wacrm-github-deploy \
  --assume-role-policy-document file://trust-policy.json
```

#### 2c. Attach a permissions policy (what the role may do)

The role only needs to send one SSM command to one instance and read the
result. Save as `permissions-policy.json`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SendDeployCommand",
      "Effect": "Allow",
      "Action": "ssm:SendCommand",
      "Resource": [
        "arn:aws:ssm:ap-south-1::document/AWS-RunShellScript",
        "arn:aws:ec2:ap-south-1:061051243529:instance/i-0c6a572bfb70328d1"
      ]
    },
    {
      "Sid": "ReadCommandResult",
      "Effect": "Allow",
      "Action": [
        "ssm:GetCommandInvocation",
        "ssm:ListCommandInvocations"
      ],
      "Resource": "*"
    }
  ]
}
```

Attach it inline:

```bash
aws iam put-role-policy \
  --role-name wacrm-github-deploy \
  --policy-name wacrm-deploy-ssm \
  --policy-document file://permissions-policy.json
```

#### 2d. Grab the role ARN

```bash
aws iam get-role --role-name wacrm-github-deploy --query 'Role.Arn' --output text
```

It will be `arn:aws:iam::061051243529:role/wacrm-github-deploy`. Put this into
the `AWS_DEPLOY_ROLE_ARN` GitHub secret (step 3).

**Console equivalent for 2b–2c:** IAM → Roles → *Create role* → *Web identity*
→ pick the `token.actions.githubusercontent.com` provider and `sts.amazonaws.com`
audience → create, then edit the trust relationship to paste the `sub` condition
above, and attach the permissions policy as an inline policy.

### 3. GitHub repo secrets and variables

Settings → Secrets and variables → Actions.

**Secrets** (encrypted):

| Name | Value |
| --- | --- |
| `AWS_DEPLOY_ROLE_ARN` | `arn:aws:iam::061051243529:role/wacrm-github-deploy` (from step 2d) |
| `DOCKERHUB_USERNAME` | Docker Hub username — used by the **build job** to push (e.g. `codewithme898`) |
| `DOCKERHUB_TOKEN` | Docker Hub **access token** with push access to the private repo — build job only |
| `NEXT_PUBLIC_SUPABASE_URL` | baked into the image at build time |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | baked into the image at build time |

> The Docker Hub creds are only used in CI to **push** the image. The EC2 box
> already has `docker login` configured, so the deploy step pulls with the box's
> own stored credential — no Docker Hub secret is passed to the instance.

**Variables** (plain):

| Name | Example | Notes |
| --- | --- | --- |
| `EC2_INSTANCE_ID` | `i-0c6a572bfb70328d1` | target instance |
| `AWS_REGION` | `ap-south-1` | defaults to `ap-south-1` if unset |
| `DOCKERHUB_REPO` | `codewithme898/neuraltalk.ai` | owner/name of the private repo |
| `NEXT_PUBLIC_SITE_URL` | `https://crm.example.com` | baked at build time |
| `NEXT_PUBLIC_APP_LOCALE` | `en` | defaults to `en` |

> `NEXT_PUBLIC_*` are inlined into the client bundle at build time, so they are
> build args in CI (not host runtime env). Server-only secrets (service role
> key, `ENCRYPTION_KEY`, `META_APP_SECRET`, `AUTOMATION_CRON_SECRET`,
> `RESEND_API_KEY`, …) stay in `.env.prod` on the box and are never baked in.

### 4. First deploy

Push to `main` (or run the workflow manually from the Actions tab). The build
job pushes the image; the deploy job rolls it out over SSM and prints the
remote `docker compose ps` + the final SSM status. The box's
`docker-compose.prod.yml` now references `${IMAGE}`, pinned to the immutable
tag for that release.

### Rollback

Re-run the deploy workflow from the commit you want, or on the box pin a known
tag:

```bash
cd /home/ubuntu/wacrm
IMAGE=codewithme898/neuraltalk.ai:prod_08_OCT_2026-0ff9ab1 \
  docker compose -f docker-compose.prod.yml --env-file .env.prod up -d
```

---

## Near-real-time reminders on this AWS box

Because the app runs as a long-lived container on EC2, the simplest cron is the
**in-process runner**: set in `.env.prod`

```bash
CRON_IN_PROCESS=true
# CRON_IN_PROCESS_INTERVAL_MS=60000   # default 1 min
```

and the container pings its own `GET /api/cron/scheduler` every minute — no
external scheduler needed. This is the recommended option here.

If you'd rather drive it externally (e.g. you run more than one instance), use
one of these instead — all hit the same endpoint with the `x-cron-secret`
header, so pick one, don't stack them:

### Option A — AWS EventBridge Scheduler (API destination)

1. EventBridge → **API destinations** → create a connection with
   **API key** auth: header name `x-cron-secret`, value =
   `AUTOMATION_CRON_SECRET`.
2. Create an API destination pointing at
   `https://YOUR_HOST/api/cron/scheduler`, method `GET`, using that connection.
3. EventBridge **Scheduler** → create schedule, rate `1 minute`, target =
   the API destination. Give the schedule an execution role that allows
   `events:InvokeApiDestination`.

This keeps the secret in the EventBridge connection, not in a script.

### Option B — Cloudflare Worker Cron Trigger

If you also use Cloudflare, the Worker in `deploy/cron-worker/` pings the
endpoint every minute:

```bash
cd deploy/cron-worker
# edit SCHEDULER_URL in wrangler.toml to your deployed endpoint
npx wrangler secret put CRON_SECRET    # paste AUTOMATION_CRON_SECRET
npx wrangler deploy
```

### Option C — GitHub Actions

`.github/workflows/scheduler-cron.yml` pings every 5 minutes (GitHub's minimum).
Add repo secrets `SCHEDULER_URL` and `AUTOMATION_CRON_SECRET`. Best-effort
timing; fine if 5-minute punctuality is acceptable.
