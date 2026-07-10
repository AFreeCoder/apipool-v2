// admin 页面多为同步 RSC（DB 查询 + 个别 New API 远端调用），没有这个文件时
// 慢查询期间整页白屏。骨架屏按「标题 + 表格卡片」的后台通用形态铺一份。
export default function AdminLoading() {
  return (
    <div className="space-y-6 p-4 md:p-6" aria-busy="true" aria-live="polite">
      <div className="bg-muted h-7 w-40 animate-pulse rounded" />

      <div className="bg-card rounded-xl border">
        <div className="border-b px-4 py-3">
          <div className="bg-muted h-3 w-32 animate-pulse rounded" />
        </div>
        <div className="divide-border divide-y">
          {Array.from({ length: 6 }).map((_, index) => (
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
