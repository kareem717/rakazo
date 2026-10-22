// @vitest-environment jsdom
import type { RefObject } from "react";
import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { useFileDrop } from "./use-file-drop";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function drag(target: EventTarget, type: string, files = true) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: {
      types: files ? ["Files"] : ["text/plain"],
      items: [{ kind: files ? "file" : "string" }],
      files: files ? [new File(["notes"], "notes.txt")] : [],
      dropEffect: "none",
    },
  });
  act(() => target.dispatchEvent(event));
  return event;
}

function setup(disabled = false) {
  const onFiles = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  function Target({ blocked }: { blocked: boolean }) {
    const ref: RefObject<HTMLDivElement | null> = useRef(null);
    const dragging = useFileDrop(ref, onFiles, blocked);
    return (
      <div ref={ref} data-dragging={dragging}>
        <span>Child</span>
      </div>
    );
  }
  function render(blocked: boolean) {
    act(() => root.render(<Target blocked={blocked} />));
  }
  render(disabled);
  const target = container.firstElementChild as HTMLElement;
  return {
    target,
    onFiles,
    render,
    cleanup() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe("useFileDrop", () => {
  it("keeps the target active across child transitions and delivers files once", () => {
    const view = setup();
    try {
      expect(drag(view.target, "dragenter").defaultPrevented).toBe(true);
      drag(view.target.firstElementChild!, "dragenter");
      drag(view.target, "dragleave");
      expect(view.target.dataset.dragging).toBe("true");
      expect(drag(view.target, "drop").defaultPrevented).toBe(true);
      expect(view.target.dataset.dragging).toBe("false");
      expect(view.onFiles).toHaveBeenCalledTimes(1);
      expect(view.onFiles.mock.calls[0]?.[0][0].name).toBe("notes.txt");
    } finally {
      view.cleanup();
    }
  });

  it("rejects files when disabled, including a composer disabled during a drag", () => {
    const view = setup();
    try {
      drag(view.target, "dragenter");
      view.render(true);
      expect(view.target.dataset.dragging).toBe("false");
      expect(drag(view.target, "dragover").defaultPrevented).toBe(true);
      expect(drag(view.target, "drop").defaultPrevented).toBe(true);
      expect(view.onFiles).not.toHaveBeenCalled();
    } finally {
      view.cleanup();
    }
  });

  it("leaves text dragging alone", () => {
    const view = setup();
    try {
      expect(drag(view.target, "dragenter", false).defaultPrevented).toBe(false);
      expect(drag(view.target, "dragover", false).defaultPrevented).toBe(false);
      expect(drag(view.target, "drop", false).defaultPrevented).toBe(false);
      expect(view.onFiles).not.toHaveBeenCalled();
    } finally {
      view.cleanup();
    }
  });

  it("preserves another upload target's accepted drag", () => {
    const view = setup();
    const other = document.createElement("div");
    document.body.append(other);
    other.addEventListener("dragover", (event) => {
      event.preventDefault();
      const transfer = (event as DragEvent).dataTransfer;
      if (transfer) transfer.dropEffect = "copy";
    });
    try {
      const event = drag(other, "dragover") as DragEvent;
      expect(event.dataTransfer?.dropEffect).toBe("copy");
      expect(view.onFiles).not.toHaveBeenCalled();
    } finally {
      other.remove();
      view.cleanup();
    }
  });

  it("clears feedback on exit, blur, and outside drops, and removes global listeners", () => {
    const view = setup();
    try {
      drag(view.target, "dragenter");
      // Some browsers omit file metadata on dragleave.
      drag(view.target, "dragleave", false);
      expect(view.target.dataset.dragging).toBe("false");
      drag(view.target, "dragenter");
      act(() => window.dispatchEvent(new Event("blur")));
      expect(view.target.dataset.dragging).toBe("false");
      drag(view.target, "dragenter");
      expect(drag(document.body, "drop").defaultPrevented).toBe(true);
      expect(view.target.dataset.dragging).toBe("false");
      expect(view.onFiles).not.toHaveBeenCalled();
    } finally {
      view.cleanup();
    }
    expect(drag(document.body, "drop").defaultPrevented).toBe(false);
  });
});
