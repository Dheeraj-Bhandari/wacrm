"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  arrayMove,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, LayoutGrid, Check, RotateCcw } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

/** A dashboard section: a stable id + the node to render. */
export interface DashboardSection {
  id: string;
  node: ReactNode;
}

interface DashboardLayoutProps {
  sections: DashboardSection[];
  /**
   * Storage key for the persisted order. Scope it per user so two
   * people on a shared machine don't clobber each other's layout.
   */
  storageKey: string;
}

/**
 * Renders the dashboard sections in a user-customizable order. A
 * "Customize" toggle reveals drag handles; dragging reorders the
 * sections and the order is persisted to localStorage. Order is keyed
 * by section id, so adding/removing a section later degrades
 * gracefully (unknown ids are dropped, new ids appended).
 */
export function DashboardLayout({ sections, storageKey }: DashboardLayoutProps) {
  const t = useTranslations("Dashboard.layout");
  const [customizing, setCustomizing] = useState(false);
  const [order, setOrder] = useState<string[] | null>(null);

  const defaultOrder = useMemo(() => sections.map((s) => s.id), [sections]);

  // Load persisted order once on mount.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) setOrder(JSON.parse(raw) as string[]);
      else setOrder(defaultOrder);
    } catch {
      setOrder(defaultOrder);
    }
    // Only re-run if the storage key changes (user switch).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Reconcile persisted order with the actual sections: keep known ids
  // in their saved order, append any new ids, drop stale ones.
  const ordered = useMemo(() => {
    const byId = new Map(sections.map((s) => [s.id, s]));
    const saved = order ?? defaultOrder;
    const result: DashboardSection[] = [];
    for (const id of saved) {
      const s = byId.get(id);
      if (s) {
        result.push(s);
        byId.delete(id);
      }
    }
    // Any sections not in the saved order (newly added) go to the end.
    for (const s of sections) if (byId.has(s.id)) result.push(s);
    return result;
  }, [sections, order, defaultOrder]);

  function persist(next: string[]) {
    setOrder(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      /* storage disabled — order still applies for this session */
    }
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids = ordered.map((s) => s.id);
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from === -1 || to === -1) return;
    persist(arrayMove(ids, from, to));
  }

  function resetLayout() {
    persist(defaultOrder);
  }

  // Avoid a hydration flash: render in default order until the stored
  // order resolves (order === null on first paint).
  const list = order === null ? sections : ordered;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-end gap-2">
        {customizing && (
          <Button variant="ghost" size="sm" onClick={resetLayout} className="text-muted-foreground">
            <RotateCcw className="h-3.5 w-3.5" />
            {t("reset")}
          </Button>
        )}
        <Button
          variant={customizing ? "default" : "outline"}
          size="sm"
          onClick={() => setCustomizing((v) => !v)}
          className={customizing ? "" : "border-border text-muted-foreground"}
        >
          {customizing ? <Check className="h-3.5 w-3.5" /> : <LayoutGrid className="h-3.5 w-3.5" />}
          {customizing ? t("done") : t("customize")}
        </Button>
      </div>

      {customizing ? (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={list.map((s) => s.id)}
            strategy={verticalListSortingStrategy}
          >
            <div className="space-y-5">
              {list.map((s) => (
                <SortableSection key={s.id} id={s.id} label={t(`section_${s.id}`)}>
                  {s.node}
                </SortableSection>
              ))}
            </div>
          </SortableContext>
        </DndContext>
      ) : (
        <div className="space-y-5">
          {list.map((s) => (
            <div key={s.id}>{s.node}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function SortableSection({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "relative rounded-xl border-2 border-dashed border-border/60 p-2 transition-colors",
        isDragging && "z-10 opacity-80",
      )}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        className="absolute -top-3 left-3 z-10 inline-flex cursor-grab items-center gap-1 rounded-md border border-border bg-card px-2 py-0.5 text-[11px] font-medium text-muted-foreground active:cursor-grabbing"
        aria-label={label}
      >
        <GripVertical className="h-3 w-3" />
        {label}
      </button>
      <div className="pointer-events-none pt-2 opacity-95">{children}</div>
    </div>
  );
}
