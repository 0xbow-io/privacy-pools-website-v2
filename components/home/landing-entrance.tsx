/* ANIMATION STORYBOARD
 *   0ms   first headline line rises through its mask
 *  80ms   second line follows; each line gains full contrast in 180ms
 * 140ms   supporting copy begins its stationary fade
 * 200ms   the anchored form begins its stationary fade
 * 680ms   headline settles; opening phrase stays until 1800ms
 * CSS owns the one-shot entrance; interactions do not replay it.
 * Reduced motion uses a short fade without movement or stagger.
 */
const ENTRANCE = {
  line: 600,
  lineFade: 180,
  lineDelay: 80,
  description: 320,
  descriptionDelay: 140,
  widget: 360,
  widgetDelay: 200,
  reduced: 160,
  fadeEasing: 'cubic-bezier(.25, .1, .25, 1)',
  lineEasing: 'cubic-bezier(.19, 1, .22, 1)',
};

export function LandingEntranceStyles() {
  return <style>{`
    @keyframes landing-enter-fade {
      from { opacity:0; }
      to { opacity:1; }
    }
    @keyframes landing-enter-line {
      from { transform:translateY(100%); }
      to { transform:none; }
    }
    @media (prefers-reduced-motion:no-preference) {
      .landing-entrance .hero-line-content {
        animation:landing-enter-line ${ENTRANCE.line}ms ${ENTRANCE.lineEasing} backwards,
          landing-enter-fade ${ENTRANCE.lineFade}ms ${ENTRANCE.fadeEasing} backwards;
      }
      .landing-entrance .hero-line + .hero-line .hero-line-content {
        animation-delay:${ENTRANCE.lineDelay}ms;
      }
      .landing-entrance .landing-entrance-description {
        animation:landing-enter-fade ${ENTRANCE.description}ms ${ENTRANCE.fadeEasing} ${ENTRANCE.descriptionDelay}ms backwards;
      }
      .landing-entrance .landing-entrance-widget {
        animation:landing-enter-fade ${ENTRANCE.widget}ms ${ENTRANCE.fadeEasing} ${ENTRANCE.widgetDelay}ms backwards;
      }
    }
    @media (prefers-reduced-motion:reduce) {
      .landing-entrance .hero-heading,
      .landing-entrance .landing-entrance-description,
      .landing-entrance .landing-entrance-widget {
        animation:landing-enter-fade ${ENTRANCE.reduced}ms ${ENTRANCE.fadeEasing} backwards;
      }
    }
  `}</style>;
}
