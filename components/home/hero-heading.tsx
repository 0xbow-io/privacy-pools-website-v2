import { LANDING_HERO } from '@/config/landing-hero';
import { useEffect, useState } from 'react';
import { Platform, Text } from 'react-native';

/* ANIMATION STORYBOARD
 *    0ms   landing entrance reveals the two lines as whole units
 * 1800ms   outgoing phrase lifts a short distance and fades as one
 * +140ms   incoming letters rise in a 120ms left-to-right cascade
 * +820ms   last letter rests exactly on the original baseline
 * 2400ms   advance again; every phrase uses the same hold
 * Reduced motion keeps public chains visible.
 */
const TIMING = {
  openingHold: 1800, // let the entrance settle and the opening message be read
  phraseHold: 2400, // steady cadence, independent of phrase length
  transition: 560, // long deceleration, with no bounce
  exit: 180, // fast, quiet departure
  cascade: 120, // total stagger window, not a delay per character
  enterDelay: 140, // near-sequential handoff without a blank beat
  fadeIn: 240, // full ink arrives before the letters finish settling
};
const WORDS = {
  phrases: LANDING_HERO.phrases,
  enterOffset: '70%',
  exitOffset: '-24%',
  enterEasing: 'cubic-bezier(.22, 1, .36, 1)',
  exitEasing: 'cubic-bezier(.4, 0, 1, 1)',
};

export function HeroHeading({ wide, active }: { wide: boolean; active: boolean }) {
  const [stage, setStage] = useState(0);
  useEffect(() => {
    if (Platform.OS !== 'web' || !active) return;
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    let timer: ReturnType<typeof setTimeout>;
    let current = 0;
    const advance = () => {
      current = (current + 1) % WORDS.phrases.length;
      setStage(current);
      timer = setTimeout(advance, TIMING.phraseHold);
    };
    const restart = () => {
      clearTimeout(timer);
      current = 0;
      setStage(0);
      if (!preference.matches) timer = setTimeout(advance, TIMING.openingHold);
    };
    restart();
    preference.addEventListener('change', restart);
    return () => {
      clearTimeout(timer);
      preference.removeEventListener('change', restart);
    };
  }, [active]);

  if (Platform.OS !== 'web') {
    return (
      <Text
        role="heading"
        aria-level={1}
        className="text-text font-pp-sans-medium text-[42px] leading-[48px] tracking-[-2px] text-center"
      >
        {`${LANDING_HERO.prefix}\n${WORDS.phrases[0]}`}
      </Text>
    );
  }
  return (
    <>
      <h1
        className={`hero-heading text-text font-pp-sans-medium ${wide ? 'hero-heading-wide' : ''}`}
        aria-label={`${LANDING_HERO.prefix} ${WORDS.phrases[0]}`}
      >
        <span className="hero-line" aria-hidden="true">
          <span className="hero-line-content">{LANDING_HERO.prefix}</span>
        </span>
        <span className="hero-line" aria-hidden="true">
          <span className="hero-words hero-line-content">
            {WORDS.phrases.map((phrase, index) => (
              <span
                key={phrase}
                className="hero-word"
                data-active={stage === index}
                data-previous={index === (stage + WORDS.phrases.length - 1) % WORDS.phrases.length}
              >
                {Array.from(phrase).map((letter, letterIndex) => (
                  <span
                    key={letterIndex}
                    className="hero-letter"
                    // nw-keep(animated): letter position and active phrase determine the transition delay.
                    style={{
                      transitionDelay: `${stage === index ? TIMING.enterDelay + (letterIndex / Math.max(1, phrase.length - 1)) * TIMING.cascade : 0}ms`,
                    }}
                  >
                    {letter === ' ' ? '\u00a0' : letter}
                  </span>
                ))}
              </span>
            ))}
          </span>
        </span>
      </h1>
      <style>{`
      .hero-heading { margin:0; font-size:42px; line-height:48px; letter-spacing:-2px; font-weight:500; text-align:center; }
      .hero-heading-wide { font-size:72px; line-height:78px; text-align:left; }
      .hero-line { display:block; overflow:hidden; }
      .hero-line-content { display:block; }
      .hero-words { display:grid; overflow:hidden; }
      .hero-word { grid-area:1 / 1; white-space:nowrap; }
      .hero-letter { display:inline-block; opacity:0; transform:translateY(${WORDS.enterOffset}); }
      .hero-word[data-previous="true"] .hero-letter { opacity:0; transform:translateY(${WORDS.exitOffset}); transition:transform ${TIMING.exit}ms ${WORDS.exitEasing}, opacity ${TIMING.exit}ms ${WORDS.exitEasing}; }
      .hero-word[data-active="true"] .hero-letter { opacity:1; transform:translateY(0); transition:transform ${TIMING.transition}ms ${WORDS.enterEasing}, opacity ${TIMING.fadeIn}ms ease-out; }
      @media (prefers-reduced-motion:reduce) {
        .hero-word .hero-letter { transition:none !important; transform:none !important; opacity:0 !important; }
        .hero-word:first-child .hero-letter { opacity:1 !important; }
      }
    `}</style>
    </>
  );
}
