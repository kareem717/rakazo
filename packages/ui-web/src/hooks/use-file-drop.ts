import type { RefObject } from "react";
import { useEffect, useRef, useState } from "react";

export function isFileDrag(dataTransfer: Pick<DataTransfer, "types" | "items"> | null): boolean {
  if (!dataTransfer) return false;
  return (
    Array.from(dataTransfer.types).includes("Files") ||
    Array.from(dataTransfer.items).some((item) => item.kind === "file")
  );
}

/** File dropping is shared by the browser and Electron's hosted interface. */
export function useFileDrop(
  targetRef: RefObject<HTMLElement | null>,
  onFiles: (files: FileList) => void,
  disabled = false,
) {
  const latestOnFiles = useRef(onFiles);
  latestOnFiles.current = onFiles;
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const target = targetRef.current;
    if (!target) return;
    let depth = 0;
    function reset() {
      depth = 0;
      setDragging(false);
    }
    reset();
    function enter(event: DragEvent) {
      if (!isFileDrag(event.dataTransfer)) return;
      event.preventDefault();
      if (!disabled) {
        depth += 1;
        setDragging(true);
      }
    }
    function over(event: DragEvent) {
      if (!isFileDrag(event.dataTransfer)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = disabled ? "none" : "copy";
      if (!disabled) setDragging(true);
    }
    function leave() {
      depth = Math.max(0, depth - 1);
      if (!depth) reset();
    }
    function drop(event: DragEvent) {
      if (!isFileDrag(event.dataTransfer)) return;
      event.preventDefault();
      reset();
      if (!disabled && event.dataTransfer?.files.length) {
        latestOnFiles.current(event.dataTransfer.files);
      }
    }
    // A file dropped outside the chat must not navigate away from the draft.
    // Other targets (such as avatar uploads) still receive their own events.
    function preventNavigation(event: DragEvent) {
      if (!isFileDrag(event.dataTransfer)) return;
      event.preventDefault();
      if (event.type === "drop") reset();
      else if (event.dataTransfer && !target?.contains(event.target as Node)) {
        event.dataTransfer.dropEffect = "none";
      }
    }
    target.addEventListener("dragenter", enter);
    target.addEventListener("dragover", over);
    target.addEventListener("dragleave", leave);
    target.addEventListener("drop", drop);
    window.addEventListener("dragover", preventNavigation);
    window.addEventListener("drop", preventNavigation);
    window.addEventListener("blur", reset);
    window.addEventListener("dragend", reset);
    return () => {
      target.removeEventListener("dragenter", enter);
      target.removeEventListener("dragover", over);
      target.removeEventListener("dragleave", leave);
      target.removeEventListener("drop", drop);
      window.removeEventListener("dragover", preventNavigation);
      window.removeEventListener("drop", preventNavigation);
      window.removeEventListener("blur", reset);
      window.removeEventListener("dragend", reset);
    };
  }, [targetRef, disabled]);

  return !disabled && dragging;
}
