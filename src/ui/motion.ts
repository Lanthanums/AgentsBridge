import { useLayoutEffect, useRef } from "react";

export function motion(duration: string, curve = "enter") {
  const tokens = getComputedStyle(document.documentElement);
  const time = tokens.getPropertyValue(`--motion-${duration}`).trim();
  return {
    duration: parseFloat(time) * (time.endsWith("ms") ? 1 : 1000),
    easing: tokens.getPropertyValue(`--ease-${curve}`).trim(),
  };
}

export const reducedMotion = () =>
  matchMedia("(prefers-reduced-motion: reduce)").matches;

function screenBox(el: Element) {
  const { x, y, width, height } = el.getBoundingClientRect();
  return { x: x + window.screenX, y: y + window.screenY, width, height };
}

export function useViewMotion(
  view: string,
  transitioning: boolean | undefined,
  preview: boolean,
  revision = 0,
) {
  const previous = useRef<{
    view: string;
    agent: string;
    box: ReturnType<typeof screenBox>;
  } | null>(null);
  const committed = useRef<{ view: string; revision: number } | null>(null);
  useLayoutEffect(() => {
    if (transitioning !== false || committed.current?.revision === revision)
      return;
    const surface = document.querySelector("#root > main");
    if (!surface) return;
    const target = surface.querySelector<HTMLElement>("[data-shared-agent]");
    const avatar = target?.querySelector(".agent-icon");
    const old = previous.current;
    const track = () => {
      if (!surface.isConnected) return;
      const anchor = surface.querySelector<HTMLElement>("[data-shared-agent]");
      if (anchor?.dataset.sharedAgent)
        previous.current = {
          view,
          agent: anchor.dataset.sharedAgent,
          box: screenBox(anchor),
        };
    };
    track();
    const reduced = reducedMotion();
    const snap = view === "ball" && committed.current?.view !== "ball";
    const surfaceAnimation =
      !committed.current || reduced
        ? surface.animate([{ opacity: 0.5 }, { opacity: 1 }], motion("fast"))
        : surface.animate(
            snap
              ? [
                  { opacity: 0.55, transform: "scale(.88,1.05)" },
                  { opacity: 1, transform: "scale(1.03,.98)", offset: 0.65 },
                  { opacity: 1, transform: "scale(1)" },
                ]
              : [
                  { opacity: 0.55, transform: "translateY(3px) scale(.985)" },
                  { opacity: 1, transform: "translateY(0) scale(1)" },
                ],
            motion("base", snap ? "spring" : "enter"),
          );
    committed.current = { view, revision };
    let shared: Animation | undefined;
    if (
      avatar &&
      target &&
      old &&
      old.view !== view &&
      old.agent === target.dataset.sharedAgent &&
      !reduced
    ) {
      const box = screenBox(target);
      // Native compact windows clip their contents to their committed bounds.
      const dx = old.box.x + old.box.width / 2 - box.x - box.width / 2;
      const dy = old.box.y + old.box.height / 2 - box.y - box.height / 2;
      const maxX = view === "ball" && !preview ? 10 : 36;
      const limit = (value: number, max: number) =>
        Math.max(-max, Math.min(max, value));
      shared = avatar.animate(
        [
          {
            transform: `translate(${limit(dx, maxX)}px, ${limit(dy, 22)}px) scale(${Math.max(0.7, Math.min(1.4, old.box.width / box.width))})`,
          },
          { transform: "translate(0, 0) scale(1)" },
        ],
        motion("slow", "spring"),
      );
    }
    const resize = new ResizeObserver(track);
    resize.observe(surface);
    if (target) resize.observe(target);
    document.addEventListener("scroll", track, true);
    return () => {
      resize.disconnect();
      document.removeEventListener("scroll", track, true);
      surfaceAnimation.cancel();
      shared?.cancel();
    };
    // Mode metadata can arrive before the native geometry commits.
  }, [transitioning, revision]);

  // The active agent can change without a window transition.
  useLayoutEffect(() => {
    if (transitioning || committed.current?.view !== view) return;
    const target = document.querySelector<HTMLElement>("[data-shared-agent]");
    if (target?.dataset.sharedAgent)
      previous.current = {
        view,
        agent: target.dataset.sharedAgent,
        box: screenBox(target),
      };
  });
}
