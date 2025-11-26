export default function UnauthorizedPage() {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <h1 className="text-3xl font-bold text-red-600">Access Denied</h1>
      <p className="text-muted-foreground mt-2">
        You don’t have permission to view this page.
      </p>
    </div>
  );
}
