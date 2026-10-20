import React from 'react';
import { LANDING_HERO } from './landing-hero';

export const STEPS = [
  {
    number: '01',
    title: 'Shield your assets',
    copy: 'Deposit into the pool. Once approved, your private balance is ready to use.',
  },
  {
    number: '02',
    title: 'Make your next move',
    copy: 'Swap, earn yield, or send privately inside the pool with supported assets.',
  },
  {
    number: '03',
    title: 'Back to your wallet',
    copy: 'Withdraw to a public wallet without any onchain link to your deposit.',
  },
];

export const QUESTIONS = [
  {
    question: 'What stays private?',
    answer: (
      <>
        Shielding is public and reveals your address, asset, and amount shielded. Once in the pool,
        zero-knowledge proofs let you use your funds privately. Withdrawing is also public, but does
        not reveal any link to your original deposit address. To learn more, see the{' '}
        <a
          href="https://privacy-pools-v2-docs.vercel.app/introduction/threat-model"
          className="text-inherit underline underline-offset-4"
        >
          Threat Model
        </a>{' '}
        section of the docs.
      </>
    ),
  },
  {
    question: 'Why are deposits reviewed?',
    answer:
      'An Association Set Provider (ASP) operated by 0xbow screens deposits to ensure funds in the pool are legitimate. This process is often completed within 1hr but can take up to 7 days. Your deposit needs approval before it can be used for private transactions.',
  },
  {
    question: 'Who controls my funds?',
    answer: (
      <>
        You authorize transactions with your own keys, so it is important to keep your account
        recovery information secure. Nobody else can authorize transactions or control your account
        on your behalf. If your deposit is not approved, you can always exit to the wallet which
        controls the note. See the{' '}
        <a
          href="https://privacy-pools-v2-docs.vercel.app/operations/ragequit"
          className="text-inherit underline underline-offset-4"
        >
          Ragequit
        </a>{' '}
        section of the docs to learn more.
      </>
    ),
  },
  {
    question: 'Which assets and networks can I use?',
    answer:
      'Available pools are listed in Explore. Select a pool to see its network, asset, and activity. Availability, limits, and fees can vary so make sure to confirm the details before submitting your transaction.',
  },
];

export const LANDING = {
  hero: LANDING_HERO,
  balance: {
    title: 'Your balance.\nYour business.',
    body: 'Shield funds in a shared pool, then use them without revealing which deposit is yours. Your keys stay in your hands.',
  },
  payments: {
    title: 'Send a link.\nGet paid privately.',
    body: 'Create a payment request and share it with the person paying you. You both stay private within the shielded pool.',
  },
  custody: {
    title: 'Self-custodial.\nNo backdoors.',
    body: 'Only your keys control your private funds, with no global viewing keys or backdoors that can deanonymize your activity. Exit anytime, regardless of approval status.',
  },
  sdk: {
    title: "Add privacy to anything you're building.",
    body: 'Bring private balances and payments to your wallet, app, or protocol with the Privacy Pools SDK. Build on shared privacy infrastructure and keep control of your user experience.',
    detail: 'Integrate shielding, private transfers, and withdrawals without building the cryptography from scratch.',
    href: 'https://privacy-pools-v2-docs.vercel.app/introduction/quickstart.html',
  },
  disclosure: {
    title: 'Private by default.\nShare on your terms.',
    body: 'Viewing keys let you share proof of individual payments or your full account history with a third-party.',
    detail: 'You choose what to reveal and who to share it with.',
    href: 'https://privacy-pools-v2-docs.vercel.app/operations/receipts-and-viewing-keys',
    linkLabel: 'Learn about viewing keys',
  },
  faqTitle: 'Frequently asked questions.',
  cta: { title: 'Get privacy for your onchain assets.', body: 'Explore pools and get started.' },
  builder: { name: '0xbow', url: 'https://0xbow.io' },
};
