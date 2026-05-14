// /privacy-policy — public privacy page.
//
// Source-controlled draft. Effective date is updated in the header
// when policy content materially changes; minor edits (rewording,
// link fixes) keep the same date.
//
// Linked from ConsentBanner + ConsentSettingsModal, and reachable
// at /privacy-policy directly.

import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy · Moonbeem",
  description:
    "How Moonbeem handles your data: what we collect, why, how long we keep it, and how to manage it.",
};

const LAST_UPDATED = "May 14, 2026";

export default function PrivacyPolicyPage() {
  return (
    <div className="min-h-screen bg-moonbeem-black px-6 py-12 text-moonbeem-ink">
      <article className="mx-auto flex max-w-2xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <h1 className="font-wordmark text-display-md text-moonbeem-pink m-0">
            Privacy
          </h1>
          <p className="text-caption text-moonbeem-ink-subtle m-0">
            Last updated: {LAST_UPDATED}
          </p>
          <p className="text-body text-moonbeem-ink-muted leading-relaxed m-0">
            This is how Moonbeem handles data. We aim for plain language. If
            anything here is unclear, write to{" "}
            <a
              className="text-moonbeem-pink hover:opacity-90"
              href="mailto:privacy@moonbeem.xyz"
            >
              privacy@moonbeem.xyz
            </a>
            .
          </p>
          <p className="text-body text-moonbeem-ink-muted leading-relaxed m-0">
            This Privacy Policy works alongside our{" "}
            <Link
              className="text-moonbeem-pink hover:opacity-90"
              href="/terms-of-service"
            >
              Terms of Service
            </Link>
            , which govern your use of the Moonbeem platform.
          </p>
        </header>

        <Section heading="Who we are">
          <p>
            Moonbeem is an authorized fan distribution platform for media.
            We&apos;re operated by Moonbeem, Inc. Reach us at{" "}
            <a
              className="text-moonbeem-pink hover:opacity-90"
              href="mailto:privacy@moonbeem.xyz"
            >
              privacy@moonbeem.xyz
            </a>
            .
          </p>
        </Section>

        <Section heading="What we collect">
          <p>
            <strong className="text-moonbeem-ink">Account data.</strong> When you
            create a Moonbeem account we collect your email address (from your
            authentication provider), the handle you choose, and any profile
            information you add (display name, bio, avatar, social links).
          </p>
          <p>
            <strong className="text-moonbeem-ink">Engagement data.</strong> When
            you interact with content on Moonbeem (opening a fan edit, clicking
            through to a partner offer), we record the event. If you&apos;ve
            granted analytics consent, we also record approximate location
            (country, region, and city derived from your IP address). We never
            collect latitude/longitude or street-level data.
          </p>
          <p>
            <strong className="text-moonbeem-ink">Payments.</strong> If you
            receive creator payouts, Stripe Connect handles your bank and tax
            data. We never store full account numbers; we hold a reference to
            your Stripe Connect account ID.
          </p>
          <p>
            <strong className="text-moonbeem-ink">Consent state.</strong> Your
            cookie banner choices are stored in a cookie on your device, and
            mirrored to our database so the choice persists across your devices
            when you&apos;re signed in.
          </p>
        </Section>

        <Section heading="Why we collect it">
          <p>
            To run the platform: routing, recommendations, partner reporting,
            creator payouts. To improve the platform: aggregate analytics tell
            us which surfaces work and where our audience is. To stay
            compliant: financial records for tax purposes.
          </p>
          <p>
            We do not sell your data. We do not share with advertisers outside
            the third-party processors listed below.
          </p>
        </Section>

        <Section heading="Third-party processors">
          <p>
            We share personal information with third-party service providers
            who help us operate Moonbeem. These processors fall into the
            following categories:
          </p>
          <ul className="flex flex-col gap-2 list-disc pl-5">
            <li>Database and authentication infrastructure</li>
            <li>Web hosting and content delivery</li>
            <li>File and media storage</li>
            <li>Payment processing</li>
            <li>Transactional email delivery</li>
            <li>Social media analytics</li>
            <li>Product analytics and error monitoring</li>
            <li>Rate limiting and caching infrastructure</li>
          </ul>
          <p>
            A current list of named processors is available on request. Contact{" "}
            <a
              className="text-moonbeem-pink hover:opacity-90"
              href="mailto:privacy@moonbeem.xyz"
            >
              privacy@moonbeem.xyz
            </a>{" "}
            for details.
          </p>
        </Section>

        <Section heading="How long we keep it">
          <ul className="flex flex-col gap-2 list-disc pl-5">
            <li>
              <strong className="text-moonbeem-ink">Engagement events</strong>{" "}
              (fan edit modal opens, platform clicks, geo records): 24 months
              from the event date
            </li>
            <li>
              <strong className="text-moonbeem-ink">Account data</strong>: kept
              as long as your account is active. When you delete your account,
              we remove the data we control within 30 days
            </li>
            <li>
              <strong className="text-moonbeem-ink">Financial records</strong>{" "}
              (withdrawals, transfers, tax-relevant data): 7 years, per US
              tax-record retention norms
            </li>
            <li>
              <strong className="text-moonbeem-ink">Email delivery logs</strong>
              : retained per Resend&apos;s policy (approximately 6 months)
            </li>
            <li>
              <strong className="text-moonbeem-ink">Consent state</strong>: 13
              months (the cookie&apos;s max age), or until you change it
            </li>
          </ul>
          <p>
            Backups may contain copies of deleted data for up to 30 days before
            being aged out.
          </p>
        </Section>

        <Section heading="Your rights">
          <p>You can:</p>
          <ul className="flex flex-col gap-2 list-disc pl-5">
            <li>
              <strong className="text-moonbeem-ink mr-0.5">Access</strong> your
              data —
              email{" "}
              <a
                className="text-moonbeem-pink hover:opacity-90"
                href="mailto:privacy@moonbeem.xyz"
              >
                privacy@moonbeem.xyz
              </a>{" "}
              from the address on your account
            </li>
            <li>
              <strong className="text-moonbeem-ink mr-0.5">Correct</strong>{" "}
              account fields — update your profile from the{" "}
              <Link
                className="text-moonbeem-pink hover:opacity-90"
                href="/me/edit"
              >
                profile settings
              </Link>{" "}
              page
            </li>
            <li>
              <strong className="text-moonbeem-ink mr-0.5">Delete</strong> your
              account — email privacy@moonbeem.xyz; we remove your account and
              cascade-delete the data we control within 30 days. Financial
              records retained for tax purposes are excepted (we&apos;ll
              explain what stays and why)
            </li>
            <li>
              <strong className="text-moonbeem-ink mr-0.5">Opt out</strong> of
              analytics or session recording — use the consent banner, or open
              Privacy
              settings from the banner&apos;s &ldquo;Customize&rdquo; button
            </li>
          </ul>
          <p>
            <Link
              className="text-moonbeem-pink hover:opacity-90"
              href="/me/privacy-settings"
            >
              Manage your consent settings →
            </Link>
          </p>
          <p>
            EU, UK, and Swiss visitors have additional rights under GDPR,
            UK-GDPR, and Swiss FADP. The rights above apply to you, plus you
            can object to processing or lodge a complaint with your national
            data-protection authority.
          </p>
        </Section>

        <Section heading="Cookies">
          <p>We use a few cookies:</p>
          <ul className="flex flex-col gap-2 list-disc pl-5">
            <li>
              <code className="font-mono text-caption text-moonbeem-pink">
                sb-*
              </code>{" "}
              — Supabase authentication state (essential, set when you sign in)
            </li>
            <li>
              <code className="font-mono text-caption text-moonbeem-pink">
                mb_consent
              </code>{" "}
              — your cookie-banner choices
            </li>
            <li>
              Analytics and session-recording cookies — set only if you&apos;ve
              granted the corresponding consent
            </li>
          </ul>
          <p>
            Privacy settings are reachable from the consent banner&apos;s
            &ldquo;Customize&rdquo; button.
          </p>
        </Section>

        <Section heading="Changes to this policy">
          <p>
            When this policy changes materially, we&apos;ll re-prompt your
            consent on your next visit. Minor edits update the date at the top
            but don&apos;t re-prompt.
          </p>
        </Section>

        <Section heading="Contact">
          <p>
            <a
              className="text-moonbeem-pink hover:opacity-90"
              href="mailto:privacy@moonbeem.xyz"
            >
              privacy@moonbeem.xyz
            </a>
          </p>
        </Section>
      </article>
    </div>
  );
}

function Section({
  heading,
  children,
}: {
  heading: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-wordmark text-heading-md text-moonbeem-ink m-0">
        {heading}
      </h2>
      <div className="flex flex-col gap-3 text-body text-moonbeem-ink-muted leading-relaxed [&_p]:m-0">
        {children}
      </div>
    </section>
  );
}
