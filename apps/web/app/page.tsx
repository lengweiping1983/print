import { ErrorBoundary } from "@/components/ErrorBoundary";
import { StudioPage } from "@/components/StudioPage";

export default function Page() {
  return (
    <ErrorBoundary>
      <StudioPage />
    </ErrorBoundary>
  );
}
