import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** An object URL for a saved photo, released when the photo changes or the view goes. */
export function usePhotoUrl(blob: Blob | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) {
      setUrl(null);
      return;
    }
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob]);
  return url;
}

/** Full-screen steps sit above the bottom bar and outside any moving sheet. */
export function AboveNav({ children }: { children: ReactNode }) {
  return createPortal(children, document.querySelector(".device") ?? document.body);
}
