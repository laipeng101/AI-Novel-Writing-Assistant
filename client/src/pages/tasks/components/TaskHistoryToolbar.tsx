import { Archive, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

interface TaskHistoryToolbarProps {
  visibility: "active" | "archived";
  onVisibilityChange: (visibility: "active" | "archived") => void;
  onOpenCleanupDialog: () => void;
  activeRecordCount: number;
}

export default function TaskHistoryToolbar({
  visibility,
  onVisibilityChange,
  onOpenCleanupDialog,
  activeRecordCount,
}: TaskHistoryToolbarProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="inline-flex rounded-xl bg-muted/50 p-1" role="tablist" aria-label="切换记录视图">
        <Button
          type="button"
          size="sm"
          variant={visibility === "active" ? "default" : "ghost"}
          className="rounded-lg"
          aria-pressed={visibility === "active"}
          onClick={() => onVisibilityChange("active")}
        >
          当前记录
        </Button>
        <Button
          type="button"
          size="sm"
          variant={visibility === "archived" ? "default" : "ghost"}
          className="rounded-lg"
          aria-pressed={visibility === "archived"}
          onClick={() => onVisibilityChange("archived")}
        >
          <RotateCcw className="h-4 w-4" aria-hidden="true" />
          已清理
        </Button>
      </div>
      {visibility === "active" ? (
        <Button type="button" variant="outline" onClick={onOpenCleanupDialog} disabled={activeRecordCount === 0}>
          <Archive className="h-4 w-4" aria-hidden="true" />
          清理记录
        </Button>
      ) : (
        <p className="text-xs text-muted-foreground">这里只保留被收起的历史记录，任务结果和正文都还在。</p>
      )}
    </div>
  );
}
