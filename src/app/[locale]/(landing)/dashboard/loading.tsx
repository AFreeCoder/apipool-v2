// dashboard 各页是同步 RSC，渲染时会阻塞在 New API 的远端调用上（单次超时
// 15s）。没有这个文件时整页白屏，只有顶部进度条。骨架屏一次覆盖控制台四个页面。
export default function DashboardLoading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="bg-card rounded-xl border p-4">
            <div className="bg-muted h-3 w-20 animate-pulse rounded" />
            <div className="bg-muted mt-3 h-6 w-28 animate-pulse rounded" />
          </div>
        ))}
      </div>

      <div className="bg-card rounded-xl border">
        <div className="border-b px-4 py-3">
          <div className="bg-muted h-3 w-32 animate-pulse rounded" />
        </div>
        <div className="divide-border divide-y">
          {Array.from({ length: 5 }).map((_, index) => (
            <div key={index} className="flex items-center gap-4 px-4 py-3">
              <div className="bg-muted h-3 w-1/4 animate-pulse rounded" />
              <div className="bg-muted h-3 w-1/6 animate-pulse rounded" />
              <div className="bg-muted h-3 w-1/6 animate-pulse rounded" />
              <div className="bg-muted ml-auto h-3 w-16 animate-pulse rounded" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
