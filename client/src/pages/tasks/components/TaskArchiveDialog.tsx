import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ApiResponse } from "@ai-novel/shared/types/api";
import type { TaskArchivePreview, TaskArchiveScope } from "@ai-novel/shared/types/task";
import { batchArchiveTasks, previewTaskArchive } from "@/api/tasks";
import { queryKeys } from "@/api/queryKeys";
import { AppDialogContent, Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { invalidateTaskVisibilityCaches } from "@/lib/taskQueryCache";
import { createIdempotencyKey } from "../taskCenterUtils";
import {
  buildCleanupConsequence,
  describeArchiveSkipReason,
  TASK_CLEANUP_SCOPE_OPTIONS,
} from "../taskArchivePresentation";

type CleanupScope = Exclude<TaskArchiveScope, "selected">;

interface TaskArchiveDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  source?: "task_center" | "director_follow_up";
}

export default function TaskArchiveDialog({
  open,
  onOpenChange,
  source = "task_center",
}: TaskArchiveDialogProps) {
  const queryClient = useQueryClient();
  const [scope, setScope] = useState<CleanupScope>("errors");
  const scopeLabel = source === "director_follow_up" ? "导演跟进" : "运行记录";

  const previewQuery = useQuery({
    queryKey: queryKeys.tasks.archivePreview(scope, source),
    queryFn: () => previewTaskArchive({
      scope,
      source,
      requestKey: `${source}-cleanup-preview`,
    }),
    enabled: open,
    staleTime: 0,
  });
  const preview = previewQuery.data?.data ?? null;

  const archiveMutation = useMutation({
    mutationFn: (nextScope: CleanupScope) => batchArchiveTasks({
      scope: nextScope,
      source,
      requestKey: createIdempotencyKey(source, "cleanup-batch"),
    }),
    onSuccess: async (response) => {
      const result = response.data;
      if (result) {
        const parts = [`已收起 ${result.archivedCount} 条记录`];
        if (result.skippedCount > 0) {
          parts.push(`${result.skippedCount} 条保持原样`);
        }
        if (result.truncated) {
          parts.push("仍有更多记录，可以再次清理");
        }
        toast.success(`${parts.join("，")}。`);
      }
      await invalidateTaskVisibilityCaches(queryClient);
      onOpenChange(false);
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "清理没有完成，请稍后重试。");
    },
  });

  return (
    <Dialog open={open} onOpenChange={(next) => {
      if (!archiveMutation.isPending) {
        onOpenChange(next);
      }
    }}>
      <AppDialogContent
        title={`清理${scopeLabel}历史记录`}
        description="选择要收起的记录范围，确认前会先显示数量。"
        footer={(
          <div className="flex w-full flex-col gap-2 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="secondary"
              disabled={archiveMutation.isPending}
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
            <Button
              type="button"
              disabled={!preview || preview.candidateCount === 0 || archiveMutation.isPending}
              onClick={() => {
                if (preview && preview.candidateCount > 0) {
                  archiveMutation.mutate(scope);
                }
              }}
            >
              {archiveMutation.isPending
                ? "正在清理…"
                : preview && preview.candidateCount > 0
                  ? `清理 ${preview.candidateCount} 条记录`
                  : "清理记录"}
            </Button>
          </div>
        )}
      >
        <div className="space-y-4">
          <div className="space-y-2" role="radiogroup" aria-label="选择清理范围">
            {TASK_CLEANUP_SCOPE_OPTIONS.map((option) => (
              <label
                key={option.value}
                className="flex cursor-pointer items-start gap-3 rounded-xl px-3 py-2 hover:bg-muted/40"
              >
                <input
                  type="radio"
                  name={`${source}-archive-scope`}
                  className="mt-1"
                  checked={scope === option.value}
                  onChange={() => setScope(option.value)}
                />
                <span>
                  <span className="block text-sm font-medium text-foreground">{option.label}</span>
                  <span className="block text-xs text-muted-foreground">{option.description}</span>
                </span>
              </label>
            ))}
          </div>

          {previewQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">正在统计可以收起的记录…</p>
          ) : null}
          {previewQuery.isError ? (
            <p className="rounded-lg bg-destructive/[0.06] px-3 py-2 text-sm text-destructive">
              {previewQuery.error instanceof Error ? previewQuery.error.message : "统计失败，请关闭后重试。"}
            </p>
          ) : null}
          {preview ? (
            <div className="space-y-1 rounded-xl bg-muted/30 px-3 py-2 text-sm">
              <p>{buildCleanupConsequence(preview.candidateCount)}</p>
              {preview.skippedCount > 0 ? (
                <p className="text-xs text-muted-foreground">
                  另有 {preview.skippedCount} 条记录不适合清理
                  {preview.skipped.length > 0
                    ? `（例如：${describeArchiveSkipReason(preview.skipped[0].reason)}）`
                    : ""}。
                </p>
              ) : null}
              {preview.truncated ? (
                <p className="text-xs text-muted-foreground">本次最多清理 500 条，完成后仍可继续清理。</p>
              ) : null}
              {preview.candidateCount === 0 ? (
                <p className="text-xs text-muted-foreground">当前范围内没有可以清理的记录。</p>
              ) : null}
            </div>
          ) : null}

          <p className="rounded-lg bg-muted/40 px-3 py-2 text-xs leading-5 text-muted-foreground">
            只会从列表中收起这些记录，不会删除任务结果或正文。
          </p>
        </div>
      </AppDialogContent>
    </Dialog>
  );
}
