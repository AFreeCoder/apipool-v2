export function Main({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-grid @container/main flex flex-1 flex-col px-4 py-8 md:px-6">
      {children}
    </div>
  );
}
