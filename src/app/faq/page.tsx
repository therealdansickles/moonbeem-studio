// /faq — public FAQ page for creators earning on Moonbeem. Static
// server component; inherits the nav, footer, and gradient background
// from the root layout.

import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "FAQ · Moonbeem",
  description:
    "Answers for creators earning on Moonbeem: verifying your social accounts, how earnings work, finding active campaigns, and getting paid.",
};

const CONTACT_CLASS = "text-moonbeem-pink hover:opacity-90";

export default function FaqPage() {
  return (
    <div className="min-h-screen px-6 py-12 text-moonbeem-ink">
      <article className="mx-auto flex max-w-3xl flex-col gap-8">
        <header className="flex flex-col gap-4">
          <h1 className="font-wordmark text-display-md text-moonbeem-pink m-0">
            FAQ
          </h1>
          <p className="text-body-lg text-moonbeem-ink-muted leading-relaxed m-0">
            Answers for creators earning on Moonbeem. If you don&apos;t find what
            you need,{" "}
            <a href="mailto:hello@moonbeem.xyz" className={CONTACT_CLASS}>
              contact us
            </a>
            .
          </p>
        </header>

        <Section heading="Getting started">
          <QA question="What is Moonbeem?">
            <p className="text-body text-moonbeem-ink-muted leading-relaxed m-0">
              Moonbeem is the ultimate network for fans of film and series.
              Download and remix authorized clips from the titles you love, post
              your edits where you already post, and earn when they perform.
            </p>
          </QA>
          <QA question="How do I start earning?">
            <p className="text-body text-moonbeem-ink-muted leading-relaxed m-0">
              Verify a social account, then submit your edits to the matching
              title page. Once your edit is verified and a campaign is active on
              that title, your views start counting.
            </p>
          </QA>
          <QA question="How do I verify my social account?">
            <p className="text-body text-moonbeem-ink-muted leading-relaxed m-0">
              In Edit Profile, open Verify your social accounts and enter your
              handle for a supported platform. You&apos;ll get a short code to
              paste anywhere in that account&apos;s bio. Save your bio, click
              &ldquo;I added it, check now,&rdquo; and Moonbeem confirms you
              control the account. The whole process takes about two minutes, and
              you can remove the code from your bio afterward.
            </p>
          </QA>
          <QA question="Which platforms are supported?">
            <p className="text-body text-moonbeem-ink-muted leading-relaxed m-0">
              Instagram, TikTok, X, and YouTube.
            </p>
          </QA>
        </Section>

        <Section heading="Earning">
          <QA question="How do earnings work?">
            <p className="text-body text-moonbeem-ink-muted leading-relaxed m-0">
              When a campaign is active on a title, every verified edit on that
              title earns at the campaign&apos;s CPM rate, a set amount per
              thousand views, based on the public view counts the platforms
              report on your posts. Earnings accrue as your views come in, until
              the campaign&apos;s budget is spent.
            </p>
          </QA>
          <QA question="How much will I earn?">
            <p className="text-body text-moonbeem-ink-muted leading-relaxed m-0">
              Each campaign sets its own CPM rate, so it varies. The rate is
              shown with the campaign, what you earn depends on that rate and the
              views your edits drive.
            </p>
          </QA>
          <QA question="How do I find active campaigns?">
            <p className="text-body text-moonbeem-ink-muted leading-relaxed m-0">
              Active campaigns appear under Active Fan Edit Campaigns with their
              reward information. When you&apos;ve made an edit, upload the link
              to your edit for attribution and inclusion in the campaign.
            </p>
          </QA>
          <QA question="Why haven't I earned anything yet?">
            <p className="text-body text-moonbeem-ink-muted leading-relaxed m-0">
              Three common reasons: there&apos;s no active campaign on the title
              yet, your edit hasn&apos;t been verified, or your views are still
              in the settling window. If none of those fit,{" "}
              <a href="mailto:hello@moonbeem.xyz" className={CONTACT_CLASS}>
                get in touch
              </a>
              .
            </p>
          </QA>
        </Section>

        <Section heading="Getting paid">
          <QA question="When does my balance become available?">
            <p className="text-body text-moonbeem-ink-muted leading-relaxed m-0">
              Views enter a settling window, currently seven days, before they
              become payable. This guards against view counts that get revised or
              removed after posting. Once settled, your earnings are available to
              withdraw.
            </p>
          </QA>
          <QA question="How do I withdraw?">
            <p className="text-body text-moonbeem-ink-muted leading-relaxed m-0">
              On your profile page, connect a payout account, then withdraw your
              available balance. The minimum withdrawal is $10.
            </p>
          </QA>
          <QA question="When does the money reach my bank?">
            <p className="text-body text-moonbeem-ink-muted leading-relaxed m-0">
              After you withdraw, bank transfer timing follows the payment
              processor&apos;s schedule. A first payout can take a little longer
              while your payout account is verified; after that, transfers are
              faster.
            </p>
          </QA>
          <QA question="Does Moonbeem charge creators anything?">
            <p className="text-body text-moonbeem-ink-muted leading-relaxed m-0">
              No. There&apos;s no fee to participate, and your earnings are yours.
            </p>
          </QA>
        </Section>

        <Section heading="Working with Moonbeem">
          <QA question="I have a film I'd like to bring to Moonbeem. Is that possible?">
            <p className="text-body text-moonbeem-ink-muted leading-relaxed m-0">
              Yes.{" "}
              <a href="mailto:hello@moonbeem.xyz" className={CONTACT_CLASS}>
                Reach out
              </a>{" "}
              and we&apos;ll get you started.
            </p>
          </QA>
          <QA question="Still have a question?">
            <p className="text-body text-moonbeem-ink-muted leading-relaxed m-0">
              <a href="mailto:hello@moonbeem.xyz" className={CONTACT_CLASS}>
                Contact us
              </a>
              , the team reads everything.
            </p>
          </QA>
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
    <section className="flex flex-col gap-5">
      <h2 className="font-wordmark text-heading-md text-moonbeem-ink m-0">
        {heading}
      </h2>
      {children}
    </section>
  );
}

function QA({
  question,
  children,
}: {
  question: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="font-wordmark text-heading-sm text-moonbeem-ink m-0">
        {question}
      </h3>
      {children}
    </div>
  );
}
