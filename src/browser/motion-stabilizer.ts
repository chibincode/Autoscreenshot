import type { Page } from "playwright";

const CAPTURE_MOTION_STYLE_ATTR = "data-autosnap-motion-stabilizer";
const CAPTURE_VIDEO_FRAME_ATTR = "data-autosnap-video-frame";
const FINITE_AUTOPLAY_VIDEO_FRACTION = 0.85;
const LOOPING_AUTOPLAY_VIDEO_FRACTION = 0.5;
const VIDEO_END_GUARD_SECONDS = 0.12;
const VIDEO_SEEK_TIMEOUT_MS = 1_200;

export const CAPTURE_MOTION_STYLE = `
  html {
    scroll-behavior: auto !important;
  }

  *,
  *::before,
  *::after {
    animation-delay: 0s !important;
    animation-duration: 1ms !important;
    animation-iteration-count: 1 !important;
    transition-delay: 0s !important;
    transition-duration: 0s !important;
    caret-color: transparent !important;
  }
`;

export interface CaptureMotionStabilityResult {
  animationsFound: number;
  animationsFinished: number;
  animationsPaused: number;
  mediaFound: number;
  mediaPaused: number;
  videoFramesSeeked: number;
}

async function ensureCaptureMotionStyle(page: Page): Promise<void> {
  const installed = await page
    .evaluate((attrName) => Boolean(document.querySelector(`style[${attrName}]`)), CAPTURE_MOTION_STYLE_ATTR)
    .catch(() => false);
  if (installed) {
    return;
  }

  const styleHandle = await page.addStyleTag({ content: CAPTURE_MOTION_STYLE });
  await styleHandle.evaluate((style, attrName) => {
    if (style instanceof Element) {
      style.setAttribute(attrName, "true");
    }
  }, CAPTURE_MOTION_STYLE_ATTR);
}

export async function stabilizeCaptureMotion(
  page: Page,
  log?: (level: "info" | "warn", message: string) => void,
  phase = "pre_capture",
): Promise<CaptureMotionStabilityResult> {
  await ensureCaptureMotionStyle(page);

  const result = await page.evaluate(async (config) => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });

    const animations =
      typeof document.getAnimations === "function" ? document.getAnimations() : [];
    let animationsFinished = 0;
    let animationsPaused = 0;

    for (const animation of animations) {
      const computedTiming = animation.effect?.getComputedTiming();
      const endTime = computedTiming?.endTime;
      const hasFiniteEnd = typeof endTime === "number" && Number.isFinite(endTime);

      try {
        if (hasFiniteEnd) {
          animation.finish();
          animationsFinished += 1;
          continue;
        }
      } catch {
        // Some animations cannot be finished (for example, an infinite WAAPI loop).
      }

      try {
        animation.currentTime = 0;
        animation.pause();
        animationsPaused += 1;
      } catch {
        // A detached or already-idle animation does not need further stabilization.
      }
    }

    const mediaElements = Array.from(document.querySelectorAll<HTMLMediaElement>("video, audio"));
    const autoplayVideos = mediaElements.filter(
      (media): media is HTMLVideoElement =>
        media instanceof HTMLVideoElement &&
        media.autoplay &&
        !media.hasAttribute(config.videoFrameAttr) &&
        media.readyState >= HTMLMediaElement.HAVE_METADATA &&
        Number.isFinite(media.duration) &&
        media.duration > config.videoEndGuardSeconds * 2,
    );
    let videoFramesSeeked = 0;

    await Promise.all(
      autoplayVideos.map(async (video) => {
        const fraction = video.loop
          ? config.loopingAutoplayVideoFraction
          : config.finiteAutoplayVideoFraction;
        const targetTime = Math.max(
          0,
          Math.min(video.duration - config.videoEndGuardSeconds, video.duration * fraction),
        );

        try {
          if (Math.abs(video.currentTime - targetTime) > 0.05) {
            await new Promise<void>((resolve) => {
              let settled = false;
              const settle = (): void => {
                if (settled) {
                  return;
                }
                settled = true;
                resolve();
              };
              video.addEventListener("seeked", settle, { once: true });
              video.currentTime = targetTime;
              window.setTimeout(settle, config.videoSeekTimeoutMs);
            });
            videoFramesSeeked += 1;
          }
          video.setAttribute(config.videoFrameAttr, targetTime.toFixed(3));
        } catch {
          // Cross-origin media can occasionally reject seeking; pausing is still deterministic.
        }
      }),
    );

    let mediaPaused = 0;
    for (const media of mediaElements) {
      if (media.paused) {
        continue;
      }
      media.pause();
      mediaPaused += 1;
    }

    if (document.fonts?.ready) {
      await document.fonts.ready.catch(() => undefined);
    }
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });

    return {
      animationsFound: animations.length,
      animationsFinished,
      animationsPaused,
      mediaFound: mediaElements.length,
      mediaPaused,
      videoFramesSeeked,
    };
  }, {
    videoFrameAttr: CAPTURE_VIDEO_FRAME_ATTR,
    finiteAutoplayVideoFraction: FINITE_AUTOPLAY_VIDEO_FRACTION,
    loopingAutoplayVideoFraction: LOOPING_AUTOPLAY_VIDEO_FRACTION,
    videoEndGuardSeconds: VIDEO_END_GUARD_SECONDS,
    videoSeekTimeoutMs: VIDEO_SEEK_TIMEOUT_MS,
  });

  log?.(
    "info",
    `motion_stabilized phase=${phase} animations=${result.animationsFound} finished=${result.animationsFinished} paused=${result.animationsPaused} media=${result.mediaFound} mediaPaused=${result.mediaPaused} videoFrames=${result.videoFramesSeeked}`,
  );
  return result;
}
