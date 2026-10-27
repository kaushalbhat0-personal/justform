"use client";
import { useEffect } from "react";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }): React.ReactElement {
  useEffect(() => {
    // Intentionally not logging payloads; the message is already user-safe.
  }, [error]);
  return (
    <div className="card">
      <h1>Something went wrong</h1>
      <div className="error" role="alert">{error.message || "Request failed."}</div>
      <div className="row">
        <button type="button" onClick={() => reset()}>Try again</button>
      </div>
    </div>
  );
}
