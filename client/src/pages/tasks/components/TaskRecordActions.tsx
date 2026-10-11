import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { TaskArchiveSource, UnifiedTaskSummary } from "@ai-novel/shared/types/task";
import { batchArchiveTasks, restoreTaskArchive } from "@/api/tasks";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { invalidateTaskVisibilityCaches } from "@/lib/taskQueryCache";
import { createIdempotencyKey } from "../taskCenterUtils";
import { getCleanupState } from "../taskArchivePresentation";

interface TaskRecordActionsProps {
  task: Pick<UnifiedTaskSummary, "kind" | "id" | "status" | "pendingManualRecovery" | "archive">;
  source?: TaskArchiveSource;
}

export default function TaskRecordActions({ task, source = "task_center" }: TaskRecordActionsProps) {
  const queryClient = useQueryClient();
  const cleanupState = getCleanupState(task);

  const cleanupMutation = useMutation({
    mutationFn: () => batchArchiveTasks({
      scope: "selected",
      entries: [{ kind: task.kind, id: task.id }],
      source,
      requestKey: createIdempotencyKey(task.id, "cleanup-single"),
    }),
    onSuccess: async (response) => {
      if (response.data && response.data.archivedCount > 0) {
        toast.success("已收起这条记录，可以在“已清理”中找回。");
      } else {
        toast.error("这条记录暂时不能清理，请稍后再试。");
        return;
      }
      await invalidateTaskVisibilityCaches(queryClient);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "清理没有完成，请稍后重试。");
    },
  });

  const restoreMutation = useMutation({
    mutationFn: () => restoreTaskArchive({ kind: task.kind, id: task.id }),
    onSuccess: async (response) => {
      if (response.data?.restored) {
        toast.success("已恢复显示这条记录。");
        await invalidateTaskVisibilityCaches(queryClient);
      } else {
        toast.error("这条记录暂时无法恢复显示。");
      }
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "恢复没有完成，请稍后重试。");
    },
  });

  if (cleanupState.mode === "hidden") {
    return null;
  }

  if (cleanupState.mode === "restore") {
    return (
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={restoreMutation.isPending}
        onClick={() => restoreMutation.mutate()}
      >
        {restoreMutation.isPending ? "正在恢复…" : "恢复显示"}
      </Button>
    );
  }

  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      disabled={Boolean(cleanupState.disabledReason) || cleanupMutation.isPending}
      title={cleanupState.disabledReason}
      onClick={() => cleanupMutation.mutate()}
    >
      {cleanupMutation.isPending ? "正在清理…" : "清理这条"}
    </Button>
  );
}
