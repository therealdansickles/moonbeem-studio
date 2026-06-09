// /partners/campaigns — public marketing page explaining how Moonbeem
// campaigns work for distribution partners. Static server component;
// inherits the nav, footer, and gradient background from the root layout.

import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Campaigns · Moonbeem",
  description:
    "How Moonbeem campaigns work for distribution partners: set a budget and CPM rate, reward fan edits for the views they drive, and pay creators on measured, platform-reported engagement.",
};

export default function PartnersPage() {
  return (
    <div className="min-h-screen px-6 py-12 text-moonbeem-ink">
      <article className="mx-auto flex max-w-3xl flex-col gap-8">
        <header className="flex flex-col gap-4">
          <h1 className="font-wordmark text-display-md text-moonbeem-pink m-0">
            Partners
          </h1>
          <div className="flex flex-col gap-4">
            <p className="text-body-lg text-moonbeem-ink-muted leading-relaxed m-0">
              Supercharge your social campaigns by rewarding the fans who bring
              the most attention to your work.
            </p>
            <p className="text-body-lg text-moonbeem-ink-muted leading-relaxed m-0">
              Moonbeem turns the clips fans already make into a measured,
              attributed channel you can fund. You set a budget and a rate; fans
              earn for the views their edits drive; you see exactly what your
              spend produced.
            </p>
          </div>
        </header>

        <Section heading="How a campaign works">
          <p>
            A campaign is a budget you fund to reward fan edits of your titles.
            You choose the titles it covers, set a rate per thousand views, and
            set a total budget. Fans who post qualifying edits earn against that
            budget as their clips accumulate views, up to the ceiling you set.
            When the budget is spent, the campaign stops paying.
          </p>
          <p>
            You control four things: the titles included, the CPM rate (what you
            pay per thousand views), the total budget, and the schedule.
            Campaigns can run open-ended until the budget is spent, or within a
            start and end window you choose.
          </p>
        </Section>

        <Section heading="Pricing and the platform fee">
          <p>
            You set your own CPM rate. There is no platform-set rate; you decide
            what a thousand views is worth for each campaign.
          </p>
          <p>
            A <strong className="text-moonbeem-ink">10% platform fee</strong> is
            added on top of your campaign budget and charged up front when you
            fund the campaign. Your full budget goes to the creator pool. A{" "}
            <strong className="text-moonbeem-ink">$1,000</strong> campaign funds
            a <strong className="text-moonbeem-ink">$1,000</strong> creator pool
            and is charged as{" "}
            <strong className="text-moonbeem-ink">$1,100</strong>.
          </p>
        </Section>

        <Section heading="How creators take part">
          <p>
            Creators verify a social handle, then submit their edits to the
            relevant title page for attribution and inclusion in a campaign.
            Only verified, published edits on a campaign&apos;s titles earn from
            it. Attribution ties each edit to the creator who made it, so the
            right person is credited and paid.
          </p>
        </Section>

        <Section heading="How views are counted">
          <p>
            Moonbeem measures the public view counts that each platform reports
            on a creator&apos;s posts, across Instagram, TikTok, X, and YouTube.
            Earnings are based on those platform-reported numbers, metered
            against your CPM rate. You pay for measured attention, on the
            platforms where your fans already post.
          </p>
        </Section>

        <Section heading="How and when creators get paid">
          <p>
            Earnings accrue as views come in. Each day&apos;s measured views
            enter a settling window — currently seven days — before they become
            payable, which guards against view counts that get revised or
            removed after posting. Once settled, the balance is payable, and
            creators withdraw their earnings to a connected payout account. Bank
            transfer timing after a withdrawal follows the payment
            processor&apos;s schedule.
          </p>
        </Section>

        <Section heading="Get started">
          <p>
            To fund a campaign or learn more about partnering with Moonbeem,{" "}
            <a
              href="mailto:hello@moonbeem.xyz"
              className="text-moonbeem-pink hover:opacity-90"
            >
              contact us
            </a>
            .
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
