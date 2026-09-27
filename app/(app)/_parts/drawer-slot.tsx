import { TaskDetailView } from "@/components/task-detail";
import { TaskDrawer } from "@/components/task-drawer";
import { SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { loadTaskDetail } from "@/lib/screens";
import { getCurrentUser } from "@/lib/supabase/server";

/** PRD 12.1: the task drawer, open on any list route with ?task=<id>. */
export async function DrawerSlot({
  taskId,
  closeHref,
}: {
  taskId: string | undefined;
  closeHref: string;
}) {
  if (!taskId) return null;
  const [detail, user] = await Promise.all([
    loadTaskDetail(taskId),
    getCurrentUser(),
  ]);
  return (
    <TaskDrawer closeHref={closeHref}>
      {detail ? (
        <TaskDetailView detail={detail} isAdmin={user?.isAdmin ?? false} />
      ) : (
        <SheetHeader className="p-6 pt-10">
          <SheetTitle>This task is not available</SheetTitle>
          <p className="text-sm text-muted-foreground">
            It may have been removed, or it is not assigned to you.
          </p>
        </SheetHeader>
      )}
    </TaskDrawer>
  );
}
