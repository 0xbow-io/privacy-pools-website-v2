// nw-keep(data-color): demo icons inherit the illustration palette through currentColor.
import { useCallback, useEffect, useRef, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { LandingReveal } from './landing-motion';
import { useTheme } from '@/components/theme-provider';
import { EthTokenIcon, UsdcTokenIcon, UsdtTokenIcon } from '@/components/ui/token-icons';
import { shieldDestinationLabel } from '@/services/hub-fiat-entry';

function DemoAmount({
  value,
  onChange,
  label,
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <input
      className="demo-amount"
      type="text"
      inputMode="decimal"
      aria-label={label}
      value={value}
      disabled={disabled}
      placeholder="0"
      autoComplete="off"
      onChange={(event) => {
        const next = event.target.value.replace(',', '.');
        if (/^\d*\.?\d*$/.test(next) && next.length <= 24) onChange(next);
      }}
    />
  );
}

function validDemoAmount(value: string) {
  return Number.isFinite(Number(value)) && Number(value) > 0;
}

function PreviewAsset({
  amount,
  asset = 'USDC',
  setAsset,
  action = '',
  excludedAsset,
  setAmount,
  disabled = false,
}: {
  amount: string;
  disabled?: boolean;
  setAmount?: (value: string) => void;
  asset?: keyof typeof SHIELD_ASSETS;
  setAsset?: (asset: keyof typeof SHIELD_ASSETS) => void;
  action?: string;
  excludedAsset?: keyof typeof SHIELD_ASSETS;
}) {
  const Icon = SHIELD_ASSETS[asset];
  return (
    <div className="preview-asset">
      {setAmount ? (
        <DemoAmount value={amount} onChange={setAmount} label={`${action} amount`} disabled={disabled} />
      ) : (
        <strong>{amount}</strong>
      )}
      {setAsset ? (
        <DemoAssetSelector
          asset={asset}
          setAsset={setAsset}
          action={action}
          excludedAsset={excludedAsset}
          disabled={disabled}
        />
      ) : (
        <span className="preview-token">
          <Icon size={24} />
          {asset}
        </span>
      )}
    </div>
  );
}

/* ANIMATION STORYBOARD
 *    0ms   show Swap when the card enters view
 *  900ms   first preview advances (Withdraw follows 250ms later)
 * 3000ms   subsequent previews advance while visible
 * Reduced motion keeps the Swap preview still.
 */
const PREVIEW_TIMING = { openingHold: 900, hold: 3000, sdkHold: 2800, withdrawOffset: 250 };
const PREVIEW_VIEWPORT = { threshold: 0.25, rootMargin: '-95px 0px 0px 0px' };
const PRIVATE_ACTIONS = ['Swap', 'Earn', 'Send'] as const;

function PrivateActionPreview() {
  const [swapFrom, setSwapFrom] = useState<keyof typeof SHIELD_ASSETS>('USDC');
  const [swapTo, setSwapTo] = useState<keyof typeof SHIELD_ASSETS>('ETH');
  const [sendAsset, setSendAsset] = useState<keyof typeof SHIELD_ASSETS>('USDC');
  const [swapInput, setSwapInput] = useState<string | null>(null);
  const [sendInput, setSendInput] = useState<string | null>(null);
  const swapFromAmount = swapInput ?? (swapFrom === 'ETH' ? '0.1' : '250');
  // Fixed illustrative conversion, not a live quote.
  const swapToAmount = validDemoAmount(swapFromAmount)
    ? String(
        Number(
          (
            (Number(swapFromAmount) * (swapFrom === 'ETH' ? 2500 : 1)) /
            (swapTo === 'ETH' ? 2500 : 1)
          ).toFixed(8),
        ),
      )
    : '0';
  const sendAmount = sendInput ?? (sendAsset === 'ETH' ? '0.1' : '100');
  const [stage, setStage] = useState(0);
  const [flows, setFlows] = useState<number[]>([0, 0, 0]); // 0: form, 1: progress, 2: done, 3: portfolio
  const flow = flows[stage];
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const started = useRef(false);
  const paused = focused || (hovered && flow !== 2);
  useEffect(() => {
    if (flow === 1 || paused) return;
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let visible = false;
    const sync = () => {
      clearTimeout(timer);
      if (visible && !preference.matches && !document.hidden) {
        timer = setTimeout(() => {
          started.current = true;
          const next = (stage + 1) % PRIVATE_ACTIONS.length;
          // Preserve the outgoing result throughout its fade; reset only the incoming card.
          setFlows((values) => values.map((value, index) => (index === next ? 0 : value)));
          setStage(next);
        }, started.current ? PREVIEW_TIMING.hold : PREVIEW_TIMING.openingHold);
      }
    };
    const observer = new IntersectionObserver(
      ([entry]) => {
        visible = entry.isIntersecting && entry.intersectionRatio >= PREVIEW_VIEWPORT.threshold;
        sync();
      },
      PREVIEW_VIEWPORT,
    );
    if (ref.current) observer.observe(ref.current);
    preference.addEventListener('change', sync);
    document.addEventListener('visibilitychange', sync);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
      preference.removeEventListener('change', sync);
      document.removeEventListener('visibilitychange', sync);
    };
  }, [stage, flow, paused]);
  useEffect(() => {
    if (flow !== 1) return;
    const timer = setTimeout(
      () => setFlows((values) => values.map((value, index) => (index === stage ? 2 : value))),
      ACTION_DEMO_TIMING.complete,
    );
    return () => clearTimeout(timer);
  }, [flow, stage]);
  return (
    <div
      className="private-preview-cycle"
      ref={ref}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false);
        setFocused(false);
      }}
      onPointerDownCapture={() => setFocused(false)}
      onFocusCapture={(event) =>
        setFocused(event.target instanceof HTMLElement && event.target.matches(':focus-visible'))
      }
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
      }}
    >
      <div className="private-preview-stack">
        {PRIVATE_ACTIONS.map((action, index) => {
          const flow = flows[index];
          return (
            <div
              key={action}
              className="action-preview private-preview-slide shield-preview"
              data-action={action.toLowerCase()}
              data-active={stage === index}
              aria-hidden={stage !== index}
              role="group"
              aria-label={`${action} preview: ${index === 0 ? `swap ${swapFrom} for ${swapTo} privately` : index === 1 ? 'illustrative shielded USDC balance earning automatically, with an example variable APY of 3 percent' : `send ${sendAsset} to a private account`}.`}
            >
              <div className="preview-header">
                <strong>{flow === 3 ? 'Your portfolio' : action}</strong>
              </div>
              {flow === 3 ? (
                <div className="demo-portfolio">
                  {[
                    { symbol: 'ETH', amount: '0.5', earned: '0.02', apy: '1.5%', Icon: EthTokenIcon },
                    { symbol: 'USDC', amount: '1,000', earned: '24', apy: '3.0%', Icon: UsdcTokenIcon },
                    { symbol: 'USDT', amount: '500', earned: '16', apy: '3.2%', Icon: UsdtTokenIcon },
                  ].map(({ symbol, amount, earned, apy, Icon }) => (
                    <div className="demo-portfolio-row" key={symbol}>
                      <Icon size={26} />
                      <span>
                        <strong>{symbol}</strong>
                        <small>{apy} APY</small>
                      </span>
                      <span className="demo-portfolio-balance">
                        <strong>{amount}</strong>
                        <small aria-label={`Yield earned: ${earned} ${symbol}`}>
                          +{earned} {symbol}
                        </small>
                      </span>
                    </div>
                  ))}
                  <span className="preview-label">Example balances · Variable APY</span>
                </div>
              ) : flow > 0 ? (
                <div className="demo-action-result" role="status" aria-live="polite">
                  {flow === 1 ? (
                    <span className="shield-demo-spinner" aria-hidden="true" />
                  ) : (
                    <Ionicons name="checkmark-circle" size={44} color="currentColor" />
                  )}
                  <strong>
                    {flow === 1
                      ? index === 0
                        ? 'Swapping…'
                        : 'Sending…'
                      : index === 0
                        ? 'Swap complete'
                        : 'Payment sent'}
                  </strong>
                  <span>
                    {index === 0
                      ? `${swapFromAmount} ${swapFrom} → ${swapToAmount} ${swapTo}`
                      : `${sendAmount} ${sendAsset}`}
                  </span>
                </div>
              ) : (
                <div className="private-preview-fields">
                  <div className="preview-field">
                    <span className="preview-label">
                      {index === 0
                        ? 'You swap'
                        : index === 1
                          ? 'Shielded balance'
                          : 'Amount to send'}
                    </span>
                    <PreviewAsset
                      amount={index === 0 ? swapFromAmount : index === 1 ? '1,000' : sendAmount}
                      asset={index === 0 ? swapFrom : index === 1 ? 'USDC' : sendAsset}
                      setAsset={index === 0 ? setSwapFrom : index === 1 ? undefined : setSendAsset}
                      setAmount={
                        index === 0 ? setSwapInput : index === 1 ? undefined : setSendInput
                      }
                      action={index === 0 ? 'Swap from' : 'Send'}
                      excludedAsset={index === 0 ? swapTo : undefined}
                    />
                  </div>
                  {index === 0 ? (
                    <>
                      <span className="preview-connector">
                        <Ionicons name="arrow-down" size={16} color="currentColor" />
                      </span>
                      <div className="preview-field">
                        <span className="preview-label">You receive privately</span>
                        <PreviewAsset
                          amount={swapToAmount}
                          asset={swapTo}
                          setAsset={setSwapTo}
                          action="Swap to"
                          excludedAsset={swapFrom}
                        />
                      </div>
                    </>
                  ) : index === 1 ? (
                    <div className="preview-yield">
                      <div className="preview-yield-rate">
                        <strong>
                          3.0<span>%</span>
                        </strong>
                        <span>APY</span>
                        <Ionicons name="trending-up" size={26} color="currentColor" />
                      </div>
                      <span className="preview-label">Example rate · Variable</span>
                    </div>
                  ) : (
                    <div className="preview-recipient">
                      <span className="preview-label">Recipient</span>
                      <div>
                        <Ionicons name="person-circle-outline" size={27} color="currentColor" />
                        <strong>Private account</strong>
                        <Ionicons name="checkmark-circle" size={18} color="currentColor" />
                      </div>
                    </div>
                  )}
                </div>
              )}
              <button
                type="button"
                className="preview-cta shield-demo-button"
                disabled={
                  flow === 1 ||
                  (flow === 0 &&
                    index !== 1 &&
                    !validDemoAmount(index === 0 ? swapFromAmount : sendAmount))
                }
                onClick={() => {
                  setFlows((values) =>
                    values.map((value, card) =>
                      card === index ? (flow >= 2 ? 0 : index === 1 ? 3 : 1) : value,
                    ),
                  );
                }}
              >
                {flow === 3
                  ? 'Back to overview'
                  : flow === 2
                    ? index === 0
                      ? 'Swap again'
                      : 'Send again'
                    : flow === 1
                      ? 'In progress…'
                      : index === 0
                        ? 'Swap privately'
                        : index === 1
                          ? 'View portfolio'
                          : 'Send privately'}
                <Ionicons
                  name={flow >= 2 ? 'refresh' : 'arrow-forward'}
                  size={17}
                  color="currentColor"
                />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const SHIELD_ASSETS = { ETH: EthTokenIcon, USDC: UsdcTokenIcon, USDT: UsdtTokenIcon };
const ACTION_DEMO_TIMING = { complete: 1100 }; // spinner, then a completed preview

function DemoAssetSelector({
  asset,
  setAsset,
  action,
  disabled,
  excludedAsset,
}: {
  asset: keyof typeof SHIELD_ASSETS;
  setAsset: (asset: keyof typeof SHIELD_ASSETS) => void;
  action: string;
  disabled: boolean;
  excludedAsset?: keyof typeof SHIELD_ASSETS;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerButton = useRef<HTMLButtonElement>(null);
  const TokenIcon = SHIELD_ASSETS[asset];
  return (
    <div
      className="shield-picker"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPickerOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          setPickerOpen(false);
          pickerButton.current?.focus();
        }
      }}
    >
      <button
        ref={pickerButton}
        type="button"
        className="preview-token shield-token-picker"
        aria-label={`${action} demo asset: ${asset}`}
        aria-expanded={pickerOpen}
        disabled={disabled}
        onClick={() => setPickerOpen(!pickerOpen)}
      >
        <TokenIcon size={24} />
        <span>{asset}</span>
        <Ionicons name="chevron-down" size={12} color="currentColor" />
      </button>
      {pickerOpen && !disabled && (
        <div className="shield-asset-menu" role="group" aria-label="Choose a demo asset">
          {(Object.keys(SHIELD_ASSETS) as (keyof typeof SHIELD_ASSETS)[])
            .filter((symbol) => symbol !== excludedAsset)
            .map((symbol) => {
              const Icon = SHIELD_ASSETS[symbol];
              return (
                <button
                  key={symbol}
                  type="button"
                  aria-pressed={asset === symbol}
                  onClick={() => {
                    setAsset(symbol);
                    setPickerOpen(false);
                    pickerButton.current?.focus();
                  }}
                >
                  <Icon size={24} />
                  <span>{symbol}</span>
                  {asset === symbol && <Ionicons name="checkmark" size={17} color="currentColor" />}
                </button>
              );
            })}
        </div>
      )}
    </div>
  );
}

/** Autoplay introduces motion soon after the illustration enters view, then allows reading time. */
function usePreviewAutoplay(
  advance: () => void,
  cycle: number | boolean,
  enabled = true,
  {
    hold = PREVIEW_TIMING.hold,
    pauseOnHover = true,
    initialDelay = 0,
  }: { hold?: number; pauseOnHover?: boolean; initialDelay?: number } = {},
) {
  const ref = useRef<HTMLDivElement>(null);
  const started = useRef(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = focused || (hovered && pauseOnHover);
  useEffect(() => {
    if (!enabled || paused) return;
    const element = ref.current;
    if (!element) return;
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let visible = false;
    const sync = () => {
      clearTimeout(timer);
      if (visible && !preference.matches && !document.hidden) {
        timer = setTimeout(() => {
          started.current = true;
          advance();
        }, started.current ? hold : PREVIEW_TIMING.openingHold + initialDelay);
      }
    };
    const observer = new IntersectionObserver(
      ([entry]) => {
        visible = entry.isIntersecting && entry.intersectionRatio >= PREVIEW_VIEWPORT.threshold;
        sync();
      },
      PREVIEW_VIEWPORT,
    );
    observer.observe(element);
    preference.addEventListener('change', sync);
    document.addEventListener('visibilitychange', sync);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
      preference.removeEventListener('change', sync);
      document.removeEventListener('visibilitychange', sync);
    };
  }, [advance, cycle, enabled, hold, initialDelay, paused]);
  return {
    ref,
    onMouseEnter: () => setHovered(true),
    onMouseLeave: () => setHovered(false),
    onPointerDownCapture: () => setFocused(false),
    onFocusCapture: (event: React.FocusEvent<HTMLDivElement>) =>
      setFocused(event.target instanceof HTMLElement && event.target.matches(':focus-visible')),
    onBlurCapture: (event: React.FocusEvent<HTMLDivElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
    },
  };
}

/** Keep each label in the same space while the outgoing and incoming text crossfade. */
function PreviewCaption({ stage, labels }: { stage: number; labels: string[] }) {
  return (
    <span className="preview-caption">
      {labels.map((label, index) => (
        <span key={index} data-active={stage === index} aria-hidden={stage !== index}>
          {label}
        </span>
      ))}
    </span>
  );
}

function TransferPreview({ action }: { action: 'Shield' | 'Withdraw' }) {
  const [amountInput, setAmountInput] = useState<string | null>(null);
  const withdrawing = action === 'Withdraw';
  const progress = withdrawing ? 'Withdrawing…' : 'Shielding…';
  const [asset, setAsset] = useState<keyof typeof SHIELD_ASSETS>(withdrawing ? 'ETH' : 'USDC');
  const amount = amountInput ?? (asset === 'ETH' ? '0.1' : '100');
  const [stage, setStage] = useState(0);
  const advance = useCallback(() => setStage((value) => (value === 0 ? 1 : 0)), []);
  const autoplay = usePreviewAutoplay(advance, stage, stage !== 1 && validDemoAmount(amount), {
    pauseOnHover: stage === 0,
    initialDelay: withdrawing && stage === 0 ? PREVIEW_TIMING.withdrawOffset : 0,
  });
  useEffect(() => {
    if (stage !== 1) return;
    const timer = setTimeout(() => setStage(2), ACTION_DEMO_TIMING.complete);
    return () => clearTimeout(timer);
  }, [stage]);
  return (
    <div
      {...autoplay}
      className="action-preview shield-preview"
      role="group"
      aria-label={`Interactive ${action} demo`}
    >
      <div className="preview-header">
        <strong>{action}</strong>
      </div>
      <div className="preview-field">
        <span className="preview-label">Amount</span>
        <PreviewAsset
          amount={amount}
          setAmount={setAmountInput}
          asset={asset}
          setAsset={setAsset}
          action={action}
          disabled={stage !== 0}
        />
      </div>
      <div className="preview-destination" role="status" aria-live="polite">
        {stage === 1 ? (
          <span className="shield-demo-spinner" aria-hidden="true" />
        ) : (
          <Ionicons
            name={
              stage === 2 ? 'checkmark-circle' : withdrawing ? 'wallet-outline' : 'shield-outline'
            }
            size={19}
            color="currentColor"
          />
        )}
        <PreviewCaption
          stage={stage}
          labels={[
            // Same wording as the real hub's destination card (services/hub-fiat-entry.ts).
            withdrawing ? 'To your wallet' : shieldDestinationLabel({ symbol: asset, chainId: 1, chainName: 'Ethereum' }),
            progress,
            withdrawing ? 'Done. Assets withdrawn.' : 'Done. Assets shielded.',
          ]}
        />
      </div>
      <button
        type="button"
        className="preview-cta shield-demo-button"
        disabled={stage === 1 || (stage === 0 && !validDemoAmount(amount))}
        onClick={() => {
          if (stage === 2) {
            setStage(0);
            setAmountInput(null);
            setAsset(withdrawing ? 'ETH' : 'USDC');
          } else {
            setStage(1);
          }
        }}
      >
        <PreviewCaption stage={stage} labels={[action, progress, `${action} again`]} />
        <Ionicons name={stage === 2 ? 'refresh' : 'arrow-forward'} size={17} color="currentColor" />
      </button>
    </div>
  );
}

/** Interactive previews use illustrative amounts and never submit transactions. */
export function StepIllustration({ step }: { step: string }) {
  const { colorScheme } = useTheme();
  return (
    <div
      className={`font-pp-sans landing-art landing-step-art landing-art-${step}`}
      data-theme={colorScheme}
      data-testid="landing-step-illustration"
    >
      {step === '02' ? (
        <PrivateActionPreview />
      ) : (
        <TransferPreview action={step === '01' ? 'Shield' : 'Withdraw'} />
      )}
    </div>
  );
}

export function PaymentIllustration() {
  const { colorScheme } = useTheme();
  const [amountInput, setAmountInput] = useState<string | null>(null);
  const [stage, setStage] = useState(0);
  const [asset, setAsset] = useState<keyof typeof SHIELD_ASSETS>('USDC');
  const amount = amountInput ?? (asset === 'ETH' ? '0.02' : '50');
  const copyVersion = useRef(0);
  const advance = useCallback(() => {
    copyVersion.current += 1;
    setStage((value) => (value === 0 ? 1 : 0));
  }, []);
  const autoplay = usePreviewAutoplay(advance, stage, stage !== 1 && validDemoAmount(amount), {
    // Keep the link available while the visitor chooses to copy or retry.
    pauseOnHover: stage !== 3,
  });
  useEffect(
    () => () => {
      copyVersion.current += 1;
    },
    [],
  );
  useEffect(() => {
    if (stage !== 1) return;
    const timer = setTimeout(() => setStage(2), ACTION_DEMO_TIMING.complete);
    return () => clearTimeout(timer);
  }, [stage]);
  const copyLink = async () => {
    // Share this illustrative flow, not a fabricated payable request.
    const link = new URL('/', window.location.origin);
    link.hash = 'payment-request-demo';
    const version = ++copyVersion.current;
    try {
      await navigator.clipboard.writeText(link.toString());
      if (version === copyVersion.current) setStage(3);
    } catch {
      if (version === copyVersion.current) setStage(4);
    }
  };
  return (
    <div
      {...autoplay}
      id="payment-request-demo"
      className="font-pp-sans landing-art payment-art"
      data-theme={colorScheme}
      role="group"
      aria-label="Interactive payment request demo"
    >
      <div className="action-preview payment-widget shield-preview">
        <div className="preview-header">
          <strong>Request</strong>
          {stage >= 2 ? (
            <button
              type="button"
              className="payment-demo-reset"
              aria-label="Create another demo request"
              onClick={() => {
                copyVersion.current += 1;
                setStage(0);
                setAmountInput(null);
                setAsset('USDC');
              }}
            >
              <Ionicons name="refresh" size={23} color="currentColor" />
            </button>
          ) : (
            <Ionicons name="link-outline" size={23} color="currentColor" />
          )}
        </div>
        <div className="preview-field">
          <span className="preview-label">Amount</span>
          <PreviewAsset
            amount={amount}
            setAmount={setAmountInput}
            asset={asset}
            setAsset={setAsset}
            action="Request"
            disabled={stage !== 0}
          />
        </div>
        <div className="preview-destination" role="status" aria-live="polite">
          {stage === 1 ? (
            <span className="shield-demo-spinner" aria-hidden="true" />
          ) : (
            <Ionicons
              name={stage >= 2 ? 'checkmark-circle' : 'shield-outline'}
              size={21}
              color="currentColor"
            />
          )}
          <PreviewCaption
            stage={stage}
            labels={[
              'Your private account',
              'Creating request…',
              'Payment request link ready',
              'Link copied',
              'Couldn’t copy. Try again.',
            ]}
          />
        </div>
        <button
          type="button"
          className="preview-cta shield-demo-button"
          disabled={stage === 1 || (stage === 0 && !validDemoAmount(amount))}
          onClick={() => {
            if (stage === 0) setStage(1);
            else void copyLink();
          }}
        >
          <PreviewCaption
            stage={stage}
            labels={['Create a request', 'Creating…', 'Copy link', 'Copied!', 'Copy link']}
          />
          <Ionicons
            name={stage >= 2 ? (stage === 3 ? 'checkmark' : 'copy-outline') : 'arrow-forward'}
            size={19}
            color="currentColor"
          />
        </button>
      </div>
    </div>
  );
}

/* ANIMATION STORYBOARD
 *    0ms   the chosen viewer sees concealed activity
 * 2800ms   a single-payment disclosure reveals one row
 * 5600ms   an account viewing key reveals all three rows
 * 8400ms   return to the concealed preview
 * Changing scope restarts the hold; keyboard focus pauses autoplay. Reduced motion stays still.
 */
const DISCLOSURE_TIMING = { hold: 2800 }; // reading time between disclosure scopes
const DISCLOSURE_SCOPES = ['Private', 'Transaction', 'Account'] as const;
const DISCLOSURE_ROWS = [
  { label: 'Shielded', amount: '0.5', asset: 'ETH', Icon: EthTokenIcon },
  { label: 'Received', amount: '+100', asset: 'USDC', Icon: UsdcTokenIcon },
  { label: 'Shielded', amount: '250', asset: 'USDT', Icon: UsdtTokenIcon },
];

export function DisclosureIllustration() {
  const { colorScheme } = useTheme();
  const [stage, setStage] = useState(0);
  const advance = useCallback(() => setStage((value) => (value + 1) % DISCLOSURE_SCOPES.length), []);
  const autoplay = usePreviewAutoplay(advance, stage, true, {
    hold: DISCLOSURE_TIMING.hold,
    initialDelay: DISCLOSURE_TIMING.hold - PREVIEW_TIMING.openingHold,
    pauseOnHover: false,
  });
  return (
    <div
      {...autoplay}
      className="font-pp-sans landing-art disclosure-art"
      data-theme={colorScheme}
      data-stage={stage}
      role="group"
      aria-label="Selective disclosure demo with example transactions"
    >
      <div className="disclosure-scene">
        <div className="disclosure-card">
          <div className="disclosure-heading">
            <span>What you share</span>
            <Ionicons name={stage === 0 ? 'eye-off-outline' : 'eye-outline'} size={22} color="currentColor" />
          </div>
          <div className="disclosure-scope" role="group" aria-label="Choose what to share in the demo">
            <span className="disclosure-scope-thumb" aria-hidden="true" />
            {DISCLOSURE_SCOPES.map((scope, index) => (
              <button key={scope} type="button" aria-pressed={stage === index} onClick={() => setStage(index)}>
                {scope}
              </button>
            ))}
          </div>
          <div className="disclosure-rows">
            {DISCLOSURE_ROWS.map((row, index) => {
              const revealed = stage === 2 || (stage === 1 && index === 1);
              return (
                <div className="disclosure-row" key={row.asset} data-revealed={revealed}>
                  <span className="disclosure-row-mask" aria-hidden={revealed}>
                    <Ionicons name="lock-closed-outline" size={18} color="currentColor" />
                    <span>••••••</span><span>•••••</span>
                  </span>
                  <span className="disclosure-row-detail" aria-hidden={!revealed}>
                    <Ionicons name="checkmark-circle-outline" size={18} color="currentColor" />
                    <span>{row.label}</span>
                    <strong className="disclosure-amount">
                      {row.amount}
                      <span className="disclosure-asset">
                        {row.asset}
                        <span aria-hidden="true"><row.Icon size={24} /></span>
                      </span>
                    </strong>
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

export function CustodyIllustration() {
  const { colorScheme } = useTheme();
  const [attempt, setAttempt] = useState(0);
  return (
    <LandingReveal loop>
      <div
        className="font-pp-sans landing-art custody-art"
        data-theme={colorScheme}
        role="group"
        aria-label="Interactive private balance illustration"
      >
        <div className="custody-scene">
          <div className="custody-balance-card">
            <div className="custody-balance-heading">
              <span>Private balance</span>
              <button
                type="button"
                className="custody-eye"
                aria-label="Try to reveal this illustrative private balance"
                onClick={() => setAttempt((value) => value + 1)}
              >
                <span>
                  <Ionicons name="eye-off-outline" size={22} color="currentColor" />
                </span>
              </button>
            </div>
            <div
              key={attempt}
              className={`custody-hidden-balance${attempt ? ' custody-refusal' : ''}`}
              aria-label="Balance concealed"
            >
              ••••••
            </div>
            <span className="custody-status" role="status">
              {attempt > 0 ? 'Balance stays private. This demo cannot reveal it.' : ''}
            </span>
            <div className="custody-asset">
              <UsdcTokenIcon size={28} />
              <span>USDC</span>
            </div>
          </div>
          <div className="custody-key-tile" aria-hidden="true">
            <Ionicons name="key" size={70} color="currentColor" />
          </div>
        </div>
      </div>
    </LandingReveal>
  );
}

export function SdkIllustration() {
  const { colorScheme } = useTheme();
  const [sdkEnabled, setSdkEnabled] = useState(false);
  const [selectedView, setSelectedView] = useState('Tokens');
  const activeView = !sdkEnabled && selectedView === 'Privacy' ? 'Tokens' : selectedView;
  useEffect(() => {
    const timer = setTimeout(
      () => setSelectedView(sdkEnabled ? 'Privacy' : 'Tokens'),
      sdkEnabled ? 240 : 0,
    );
    return () => clearTimeout(timer);
  }, [sdkEnabled]);
  const advance = useCallback(() => setSdkEnabled((value) => !value), []);
  const autoplay = usePreviewAutoplay(advance, sdkEnabled, true, { hold: PREVIEW_TIMING.sdkHold });
  const assets = [
    {
      symbol: 'ETH',
      name: 'Ethereum',
      publicAmount: '1.5',
      privateAmount: '0.4',
      Icon: EthTokenIcon,
    },
    {
      symbol: 'USDC',
      name: 'USDC',
      publicAmount: '1,250',
      privateAmount: '500',
      Icon: UsdcTokenIcon,
    },
  ];
  return (
    <div
      {...autoplay}
      className="font-pp-sans landing-art sdk-art"
      data-theme={colorScheme}
      role="group"
      aria-label="Wallet integration demo"
    >
      <div className="sdk-scene" data-private={sdkEnabled}>
        <div className="sdk-app">
          <div className="sdk-app-title">
            <span>Wallet</span>
            <Ionicons name="wallet-outline" size={22} color="currentColor" />
          </div>
          <div className="sdk-wallet-actions" aria-label="Illustrative wallet actions">
            {[
              { label: 'Send', icon: 'arrow-up-outline' },
              { label: 'Receive', icon: 'arrow-down-outline' },
              { label: 'Swap', icon: 'swap-horizontal-outline' },
            ].map(({ label, icon }) => (
              <div className="sdk-wallet-action" key={label}>
                <span>
                  <Ionicons
                    name={
                      icon as 'arrow-up-outline' | 'arrow-down-outline' | 'swap-horizontal-outline'
                    }
                    size={20}
                    color="currentColor"
                  />
                </span>
                <strong>{label}</strong>
              </div>
            ))}
            <div className="sdk-wallet-action sdk-shield-action" aria-hidden={!sdkEnabled}>
              <span>
                <Ionicons name="shield-outline" size={20} color="currentColor" />
              </span>
              <strong>Shield</strong>
            </div>
          </div>
          <div className="sdk-wallet-tabs" role="group" aria-label="Wallet views">
            {['Tokens', 'Privacy', 'Activity'].map((view) => (
              <button
                key={view}
                type="button"
                className={view === 'Privacy' ? 'sdk-privacy-tab' : undefined}
                aria-pressed={activeView === view}
                aria-hidden={view === 'Privacy' && !sdkEnabled}
                tabIndex={view === 'Privacy' && !sdkEnabled ? -1 : 0}
                disabled={view === 'Privacy' && !sdkEnabled}
                onClick={() => setSelectedView(view)}
              >
                {view}
              </button>
            ))}
          </div>
          <div className="sdk-wallet-panels" id="sdk-private-balances">
            {[false, true].map((privatePanel) => (
              <div
                key={String(privatePanel)}
                className="sdk-wallet-panel"
                data-active={activeView === (privatePanel ? 'Privacy' : 'Tokens')}
                aria-hidden={activeView !== (privatePanel ? 'Privacy' : 'Tokens')}
              >
                <div className="sdk-label">
                  {privatePanel ? 'Private balances' : 'Public balances'}
                </div>
                {assets.map(({ symbol, name, publicAmount, privateAmount, Icon }) => (
                  <div className="sdk-token-row" key={symbol}>
                    <Icon size={28} />
                    <span>{name}</span>
                    <strong>{privatePanel ? privateAmount : publicAmount}</strong>
                  </div>
                ))}
              </div>
            ))}
            <div
              className="sdk-wallet-panel"
              data-active={activeView === 'Activity'}
              aria-hidden={activeView !== 'Activity'}
            >
              <div className="sdk-label">Recent activity</div>
              <div className="sdk-token-row">
                <EthTokenIcon size={28} />
                <span>Received ETH</span>
                <strong>+0.5</strong>
              </div>
              <div className="sdk-token-row">
                <UsdcTokenIcon size={28} />
                <span>
                  {sdkEnabled ? (
                    <>
                      Private transfer
                      <small className="sdk-transfer-recipient">
                        To <span aria-label="Recipient concealed">••••••</span>
                      </small>
                    </>
                  ) : (
                    'Sent USDC'
                  )}
                </span>
                <strong>−100</strong>
              </div>
            </div>
          </div>
        </div>
        <button
          type="button"
          className="sdk-mode"
          role="switch"
          aria-checked={sdkEnabled}
          aria-controls="sdk-private-balances"
          onClick={() => setSdkEnabled((value) => !value)}
        >
          <Ionicons name="code-slash" size={20} color="currentColor" />
          <span>Privacy Pools SDK</span>
          <span className="sdk-switch" aria-hidden="true">
            <span />
          </span>
        </button>
      </div>
    </div>
  );
}
