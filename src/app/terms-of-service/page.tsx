// /terms-of-service — public terms of service page.
//
// Mirrors /privacy-policy structure + styling: same Section
// primitive, same typography tokens, same prose width, same
// dark/pink palette. Server component, no interactivity.
//
// Content is a faithful transcription of terms_of_service_v2.md —
// the legal language is verbatim. The "Plain summary" lead-in on
// each substantive section is part of the source document, not an
// editorial addition. All-caps in §11 and §12 is a legal
// convention preserved as-is.

import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Terms of Service · Moonbeem",
  description:
    "The terms that govern your use of Moonbeem: accounts, content you upload, creator payments, and dispute resolution.",
};

const EFFECTIVE_DATE = "May 14, 2026";

export default function TermsOfServicePage() {
  return (
    <div className="min-h-screen bg-moonbeem-black px-6 py-12 text-moonbeem-ink">
      <article className="mx-auto flex max-w-2xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <h1 className="font-wordmark text-display-md text-moonbeem-pink m-0">
            Terms of Service
          </h1>
          <p className="text-caption text-moonbeem-ink-subtle m-0">
            Effective date: {EFFECTIVE_DATE}
          </p>
          <p className="text-body text-moonbeem-ink-muted leading-relaxed m-0">
            These Terms govern your use of Moonbeem. Moonbeem is operated by
            Moonbeem, Inc., a Delaware corporation (&ldquo;Moonbeem,&rdquo;{" "}
            &ldquo;we,&rdquo; or &ldquo;us&rdquo;). By using Moonbeem, you agree
            to these Terms. If you do not agree, do not use the service.
          </p>
          <p className="text-body text-moonbeem-ink-muted leading-relaxed m-0">
            We&apos;ve tried to write these Terms in plain language. Where legal
            precision matters, we use precise terms — but each substantive
            section begins with a short summary of what it actually says.
          </p>
        </header>

        <Section heading="1. Who can use Moonbeem">
          <PlainSummary>
            You can use Moonbeem if you are at least 13 years old. To receive
            creator payouts, you must be at least 18 and complete identity
            verification through our payments partner.
          </PlainSummary>
          <p>
            You may use Moonbeem if you are at least 13 years old. If you are
            under 18, you may use Moonbeem with the consent and supervision of a
            parent or legal guardian, who agrees to be bound by these Terms on
            your behalf.
          </p>
          <p>
            To receive creator payouts on Moonbeem, you must be at least 18
            years old and complete identity verification through Stripe Connect,
            our payments partner. Creators under 18 may use the platform, build
            a creator profile, and accumulate earnings — but earnings cannot be
            withdrawn until you turn 18 and complete the verification process.
          </p>
          <p>
            You may not use Moonbeem if you have been previously suspended or
            removed from the service, or if your jurisdiction prohibits use of
            platforms like Moonbeem.
          </p>
        </Section>

        <Section heading="2. Your account">
          <PlainSummary>
            Keep your account information accurate and your credentials secure.
            You&apos;re responsible for activity on your account.
          </PlainSummary>
          <p>
            When you create an account, you agree to provide accurate
            information and keep it current. You are responsible for maintaining
            the security of your account credentials and for all activity that
            occurs under your account.
          </p>
          <p>
            You may have only one personal account at a time. Creating multiple
            accounts to evade restrictions, manipulate metrics, or circumvent
            these Terms is prohibited.
          </p>
          <p>
            You may delete your account at any time through your account
            settings. We may suspend or terminate accounts that violate these
            Terms, as described in Section 10.
          </p>
        </Section>

        <Section heading="3. What Moonbeem is">
          <PlainSummary>
            Moonbeem is an authorized fan distribution platform for media. We
            provide infrastructure for fans to share, remix, and earn from
            authorized media content. We are not a content owner.
          </PlainSummary>
          <p>
            Moonbeem is a platform that connects fan creators, audiences, and
            authorized rights holders. We provide tools for fans to create and
            share content derived from authorized media works, attribution
            infrastructure that tracks the relationship between fan content and
            source works, and commerce infrastructure that enables transactions
            between audiences and rights holders.
          </p>
          <p>
            Moonbeem does not own the underlying media works distributed through
            the platform. Rights holders retain ownership of their works and
            authorize specific uses through our platform. Fan creators retain
            ownership of their original creative contributions, subject to the
            license described in Section 4.
          </p>
          <p>
            We do not guarantee any specific outcomes from using Moonbeem,
            including views, earnings, audience growth, or partnership
            opportunities. Performance depends on many factors outside our
            control.
          </p>
        </Section>

        <Section heading="4. Content you upload">
          <PlainSummary>
            You own your content. By uploading, you give us permission to
            display, distribute, and promote it through Moonbeem. You&apos;re
            responsible for ensuring you have the rights to what you upload.
          </PlainSummary>
          <p>
            When you upload content to Moonbeem (&ldquo;Your Content&rdquo;), you
            retain ownership of that content. You grant Moonbeem a worldwide,
            non-exclusive, royalty-free license to:
          </p>
          <ul className="flex flex-col gap-2 list-disc pl-5">
            <li>
              Host, display, and distribute Your Content on the Moonbeem
              platform
            </li>
            <li>
              Make technical modifications necessary for formatting, encoding,
              and delivery (such as creating thumbnails, generating preview
              clips, or transcoding video formats)
            </li>
            <li>
              Promote Your Content within Moonbeem and in connection with
              Moonbeem&apos;s marketing, including case studies, social media
              posts, partner showcases, and similar contexts
            </li>
            <li>
              Sublicense the above rights to our service providers as needed to
              operate the platform
            </li>
          </ul>
          <p>
            This license continues for as long as Your Content is on Moonbeem,
            plus a reasonable period afterward for backup and archive purposes.
            If you delete Your Content or your account, we will remove the
            content from public display within a reasonable timeframe, though
            some copies may remain in backups or cached versions for a limited
            time.
          </p>
          <p>You represent and warrant that:</p>
          <ul className="flex flex-col gap-2 list-disc pl-5">
            <li>You own or have all necessary rights to Your Content</li>
            <li>
              Your Content does not infringe any third-party rights, including
              copyright, trademark, publicity, or privacy rights
            </li>
            <li>
              Your Content complies with these Terms and applicable law
            </li>
            <li>
              For fan content derived from authorized media works, you are using
              the work in a manner consistent with the rights holder&apos;s
              authorization on Moonbeem
            </li>
          </ul>
        </Section>

        <Section heading="5. Authorized fan distribution">
          <PlainSummary>
            Moonbeem operates an authorization protocol that connects fan
            creators with rights holders. When you upload fan content derived
            from an authorized work, you agree to attribution and protocol
            requirements.
          </PlainSummary>
          <p>
            Moonbeem&apos;s core function is enabling authorized fan
            distribution. This means:
          </p>
          <ul className="flex flex-col gap-2 list-disc pl-5">
            <li>
              Rights holders (&ldquo;Partners&rdquo;) authorize specific media
              works for fan creation and distribution on Moonbeem
            </li>
            <li>
              Fan creators may create derivative content from authorized works,
              subject to the authorization terms set by the Partner
            </li>
            <li>
              All authorized fan content carries attribution to both the
              original work and the fan creator
            </li>
            <li>
              Moonbeem tracks attribution through our provenance infrastructure
            </li>
            <li>
              Earnings flow according to the protocol rates set by the Partner
              and Moonbeem
            </li>
          </ul>
          <p>
            When you create fan content from an authorized work, you agree to:
          </p>
          <ul className="flex flex-col gap-2 list-disc pl-5">
            <li>
              Maintain attribution to the underlying work and rights holder
            </li>
            <li>
              Comply with any specific terms set by the rights holder (for
              example, distribution windows, geographic restrictions, or
              use-case limitations)
            </li>
            <li>
              Use the work in ways consistent with the authorization (commercial
              vs. non-commercial, transformative vs. derivative, etc.)
            </li>
          </ul>
          <p>
            If a work is not authorized on Moonbeem, you may not create fan
            content derived from that work on our platform. Unauthorized
            derivative content will be removed under our DMCA process (Section
            9).
          </p>
        </Section>

        <Section heading="6. Payments and creator payouts">
          <PlainSummary>
            Creators earn from authorized fan activity. Payments flow through
            Stripe Connect. You&apos;re responsible for your own taxes.
          </PlainSummary>
          <p>
            Creators on Moonbeem may earn payouts based on activity attributed
            to their content, according to protocol rates set in coordination
            with rights holders. Current payout rates and qualifying activity
            are described in your creator dashboard and may be updated from time
            to time.
          </p>
          <p>
            <strong className="text-moonbeem-ink">Stripe Connect:</strong> All
            creator payouts are processed through Stripe Connect. To receive
            payouts, you must create a Stripe Connect account and agree to the
            Stripe Connect Account Agreement and Stripe Services Agreement.
            Stripe&apos;s terms govern the payments relationship; Moonbeem&apos;s
            Terms govern your relationship with our platform.
          </p>
          <p>
            <strong className="text-moonbeem-ink">
              Identity verification:
            </strong>{" "}
            Stripe requires identity verification before payouts can be issued.
            We do not control this verification process and are not responsible
            for delays or denials by Stripe.
          </p>
          <p>
            <strong className="text-moonbeem-ink">Payout timing:</strong>{" "}
            Earnings accumulate in your creator account and become available for
            payout according to the schedule described in your creator
            dashboard. We may hold or delay payouts in cases of suspected fraud,
            chargebacks, disputes, or violations of these Terms.
          </p>
          <p>
            <strong className="text-moonbeem-ink">Taxes:</strong> You are solely
            responsible for any taxes owed on your earnings from Moonbeem. We
            will issue tax forms (such as 1099-NEC for US creators) as required
            by law.
          </p>
          <p>
            <strong className="text-moonbeem-ink">Disputes:</strong> If you
            believe a payout calculation is incorrect, contact us at{" "}
            <MailLink /> within 60 days of the disputed transaction. We will
            review and respond within a reasonable time.
          </p>
          <p>
            <strong className="text-moonbeem-ink">
              Refunds and chargebacks:
            </strong>{" "}
            If a transaction that generated your earnings is refunded or charged
            back, the corresponding earnings will be reversed from your account.
          </p>
        </Section>

        <Section heading="7. Intellectual property">
          <PlainSummary>
            Moonbeem owns its platform and brand. You own your content.
            Don&apos;t infringe third-party rights.
          </PlainSummary>
          <p>
            <strong className="text-moonbeem-ink">Moonbeem&apos;s IP:</strong>{" "}
            The Moonbeem platform, including our software, design, brand,
            trademarks, and protocol architecture, is owned by Moonbeem, Inc.
            and protected by intellectual property law. These Terms do not grant
            you any rights to our IP except the limited right to use the
            platform as intended.
          </p>
          <p>
            <strong className="text-moonbeem-ink">Your IP:</strong> You retain
            ownership of Your Content, subject to the license in Section 4.
          </p>
          <p>
            <strong className="text-moonbeem-ink">Partner IP:</strong> Authorized
            media works distributed through Moonbeem remain the property of
            their respective rights holders. Your use of these works is limited
            to the authorization granted by the rights holder on Moonbeem.
          </p>
          <p>
            <strong className="text-moonbeem-ink">
              Respect for third parties:
            </strong>{" "}
            You may not upload, distribute, or create content on Moonbeem that
            infringes any third party&apos;s intellectual property rights. If you
            believe content on Moonbeem infringes your rights, see Section 9 for
            our DMCA process.
          </p>
        </Section>

        <Section heading="8. Prohibited conduct">
          <PlainSummary>
            Don&apos;t do anything illegal, harmful, deceptive, or that
            interferes with the platform.
          </PlainSummary>
          <p>
            You may not, in connection with your use of Moonbeem:
          </p>
          <ul className="flex flex-col gap-2 list-disc pl-5">
            <li>
              Upload content that is illegal, harassing, defamatory, fraudulent,
              threatening, obscene, or otherwise objectionable
            </li>
            <li>
              Upload content that sexualizes minors or that any reasonable
              person would find exploitative of minors
            </li>
            <li>
              Impersonate any person or entity, or misrepresent your affiliation
              with any person or entity
            </li>
            <li>
              Manipulate platform metrics, including views, earnings, or
              engagement, through automated means or coordinated schemes
            </li>
            <li>
              Circumvent any authentication, authorization, or technical
              protection measure
            </li>
            <li>
              Use the platform to distribute malware, viruses, or other harmful
              code
            </li>
            <li>
              Scrape, crawl, or use automated tools to access Moonbeem except
              through our public APIs and within published rate limits
            </li>
            <li>
              Reverse engineer, decompile, or attempt to derive source code from
              the platform
            </li>
            <li>
              Interfere with or disrupt the integrity or performance of the
              platform
            </li>
            <li>
              Use the platform for any commercial purpose not expressly
              permitted by these Terms
            </li>
          </ul>
          <p>
            We may investigate and take action against any violation, including
            content removal, account suspension or termination, and reporting to
            law enforcement where appropriate.
          </p>
        </Section>

        <Section heading="9. Copyright and DMCA">
          <PlainSummary>
            If you believe content on Moonbeem infringes your copyright, send us
            a DMCA notice. We have a process to handle this.
          </PlainSummary>
          <p>
            Moonbeem respects intellectual property rights. We respond to clear
            notices of alleged copyright infringement as required by the Digital
            Millennium Copyright Act (&ldquo;DMCA&rdquo;). Moonbeem is a
            registered DMCA service provider (Registration Number:
            DMCA-1072736).
          </p>
          <p>
            <strong className="text-moonbeem-ink">
              To submit a DMCA notice
            </strong>
            , send the following information to our designated agent:
          </p>
          <AddressCard
            lines={[
              "DMCA Designated Agent",
              "Daniel Sickles",
              "Moonbeem, Inc.",
              "255 Eastern Parkway",
              "Brooklyn, NY 11238",
            ]}
            emailPrefix="Email: "
          />
          <p>Your notice must include:</p>
          <ol className="flex flex-col gap-2 list-decimal pl-5">
            <li>
              A physical or electronic signature of the copyright owner or
              authorized agent
            </li>
            <li>
              Identification of the copyrighted work claimed to be infringed
            </li>
            <li>
              Identification of the material on Moonbeem claimed to be
              infringing, with enough detail for us to locate it (URL is
              helpful)
            </li>
            <li>Your contact information (address, phone, email)</li>
            <li>
              A statement that you have a good-faith belief that the use is not
              authorized
            </li>
            <li>
              A statement, under penalty of perjury, that the information in
              your notice is accurate and that you are the rights holder or
              authorized agent
            </li>
          </ol>
          <p>
            <strong className="text-moonbeem-ink">Counter-notices:</strong> If
            your content was removed and you believe the removal was in error,
            you may submit a counter-notice including the elements specified in
            17 U.S.C. § 512(g).
          </p>
          <p>
            <strong className="text-moonbeem-ink">Repeat infringers:</strong> We
            will terminate accounts of users who are determined to be repeat
            infringers under appropriate circumstances.
          </p>
          <p>
            <strong className="text-moonbeem-ink">Misrepresentations:</strong>{" "}
            Submitting a false DMCA notice or counter-notice may result in legal
            liability under 17 U.S.C. § 512(f).
          </p>
        </Section>

        <Section heading="10. Suspension and termination">
          <PlainSummary>
            Either of us can end your account. If we terminate for cause, you
            may lose access to earnings still in dispute.
          </PlainSummary>
          <p>
            <strong className="text-moonbeem-ink">You may terminate</strong>{" "}
            your account at any time through your account settings or by
            contacting <MailLink />. Upon termination, your content will be
            removed from public display, and any payable earnings will be
            processed according to Section 6 (subject to Stripe Connect
            requirements).
          </p>
          <p>
            <strong className="text-moonbeem-ink">
              We may suspend or terminate
            </strong>{" "}
            your account or access to specific features at any time, with or
            without notice, if:
          </p>
          <ul className="flex flex-col gap-2 list-disc pl-5">
            <li>You materially breach these Terms</li>
            <li>
              Your conduct creates legal exposure for Moonbeem or other users
            </li>
            <li>
              You engage in fraud, manipulation, or repeated policy violations
            </li>
            <li>
              We are required to do so by law or by a partner agreement
            </li>
            <li>We discontinue the service or substantially modify it</li>
          </ul>
          <p>
            <strong className="text-moonbeem-ink">
              Effect of termination:
            </strong>{" "}
            Upon termination, your right to use Moonbeem ends. Sections that by
            their nature should survive (including IP, indemnification,
            disclaimers, limitation of liability, and dispute resolution) will
            survive termination.
          </p>
          <p>
            <strong className="text-moonbeem-ink">
              Earnings on termination:
            </strong>{" "}
            If your account is terminated for cause (fraud, manipulation,
            breach), we may withhold earnings that we reasonably believe are
            connected to the violation. Earnings unrelated to the violation will
            be paid out according to normal payout procedures.
          </p>
        </Section>

        <Section heading="11. Disclaimers">
          <PlainSummary>
            Moonbeem is provided &ldquo;as is.&rdquo; We don&apos;t promise it
            will always work perfectly or meet your specific needs.
          </PlainSummary>
          <p>
            MOONBEEM IS PROVIDED &ldquo;AS IS&rdquo; AND &ldquo;AS
            AVAILABLE.&rdquo; TO THE FULLEST EXTENT PERMITTED BY LAW, MOONBEEM
            AND ITS AFFILIATES, OFFICERS, EMPLOYEES, AND AGENTS DISCLAIM ALL
            WARRANTIES, EXPRESS OR IMPLIED, INCLUDING IMPLIED WARRANTIES OF
            MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, AND
            NON-INFRINGEMENT.
          </p>
          <p>
            WE DO NOT WARRANT THAT THE PLATFORM WILL BE UNINTERRUPTED,
            ERROR-FREE, SECURE, OR FREE OF VIRUSES OR OTHER HARMFUL COMPONENTS.
            WE DO NOT WARRANT ANY SPECIFIC OUTCOMES, INCLUDING EARNINGS, AUDIENCE
            GROWTH, OR PARTNERSHIP OPPORTUNITIES.
          </p>
          <p>YOU USE MOONBEEM AT YOUR OWN RISK.</p>
        </Section>

        <Section heading="12. Limitation of liability">
          <PlainSummary>
            Our maximum responsibility to you is capped at $100. We&apos;re not
            responsible for indirect damages.
          </PlainSummary>
          <p>
            TO THE FULLEST EXTENT PERMITTED BY LAW, MOONBEEM, INC. AND ITS
            AFFILIATES, OFFICERS, EMPLOYEES, AND AGENTS WILL NOT BE LIABLE TO YOU
            FOR ANY INDIRECT, INCIDENTAL, CONSEQUENTIAL, SPECIAL, EXEMPLARY, OR
            PUNITIVE DAMAGES ARISING FROM YOUR USE OF MOONBEEM, EVEN IF WE HAVE
            BEEN ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.
          </p>
          <p>
            OUR TOTAL CUMULATIVE LIABILITY TO YOU FOR ALL CLAIMS ARISING FROM OR
            RELATING TO THESE TERMS OR YOUR USE OF MOONBEEM WILL NOT EXCEED ONE
            HUNDRED DOLLARS ($100).
          </p>
          <p>
            SOME JURISDICTIONS DO NOT ALLOW THE EXCLUSION OR LIMITATION OF
            CERTAIN DAMAGES. IN THOSE JURISDICTIONS, OUR LIABILITY IS LIMITED TO
            THE MAXIMUM EXTENT PERMITTED BY LAW.
          </p>
        </Section>

        <Section heading="13. Indemnification">
          <PlainSummary>
            If your conduct or content gets us sued, you&apos;ll cover our costs.
          </PlainSummary>
          <p>
            You agree to defend, indemnify, and hold harmless Moonbeem, Inc. and
            its affiliates, officers, employees, and agents from and against any
            claims, damages, costs, and expenses (including reasonable
            attorneys&apos; fees) arising from:
          </p>
          <ul className="flex flex-col gap-2 list-disc pl-5">
            <li>Your use of Moonbeem</li>
            <li>Your violation of these Terms</li>
            <li>Your Content or your conduct on the platform</li>
            <li>
              Your violation of any third-party rights, including intellectual
              property, privacy, or publicity rights
            </li>
          </ul>
          <p>
            We reserve the right to assume the exclusive defense of any matter
            subject to indemnification, in which case you will cooperate with us
            in asserting any available defenses.
          </p>
        </Section>

        <Section heading="14. Disputes and governing law">
          <PlainSummary>
            These Terms are governed by Delaware law. Most disputes go through
            arbitration, not court. You waive the right to participate in class
            actions.
          </PlainSummary>
          <p>
            <strong className="text-moonbeem-ink">Governing law:</strong> These
            Terms are governed by the laws of the State of Delaware, without
            regard to its conflict of law principles.
          </p>
          <p>
            <strong className="text-moonbeem-ink">Arbitration:</strong> Any
            dispute arising from or relating to these Terms or your use of
            Moonbeem will be resolved through binding individual arbitration,
            except as described below. Arbitration will be administered by the
            American Arbitration Association under its Consumer Arbitration
            Rules. The arbitration will take place in Delaware, or by video
            conference if both parties agree.
          </p>
          <p>
            <strong className="text-moonbeem-ink">Carve-outs:</strong> The
            following disputes are not subject to arbitration:
          </p>
          <ul className="flex flex-col gap-2 list-disc pl-5">
            <li>
              Claims for injunctive relief related to intellectual property
            </li>
            <li>
              Claims that may be brought in small claims court within that
              court&apos;s jurisdictional limits
            </li>
            <li>
              Disputes that local law requires to be heard in a specific court
            </li>
          </ul>
          <p>
            <strong className="text-moonbeem-ink">Class action waiver:</strong>{" "}
            You agree that disputes will be resolved on an individual basis. You
            waive any right to participate in a class action, class arbitration,
            or representative proceeding. The arbitrator may not consolidate
            claims or preside over any form of representative proceeding.
          </p>
          <p>
            <strong className="text-moonbeem-ink">Opt out:</strong> You may opt
            out of this arbitration agreement by sending written notice to{" "}
            <MailLink /> within 30 days of first accepting these Terms. Opting
            out does not affect the rest of these Terms.
          </p>
        </Section>

        <Section heading="15. Changes to these Terms">
          <PlainSummary>
            We may update these Terms. We&apos;ll notify you of material changes.
            Continued use means you accept the updated Terms.
          </PlainSummary>
          <p>
            We may update these Terms from time to time. When we make material
            changes, we will:
          </p>
          <ul className="flex flex-col gap-2 list-disc pl-5">
            <li>
              Update the &ldquo;Effective date&rdquo; at the top of these Terms
            </li>
            <li>
              Notify you through the platform, by email, or both, at least 30
              days before the changes take effect (for material changes)
            </li>
          </ul>
          <p>
            Your continued use of Moonbeem after the effective date of updated
            Terms constitutes your acceptance of the changes. If you do not
            agree to updated Terms, you must stop using Moonbeem and may
            terminate your account.
          </p>
        </Section>

        <Section heading="16. General">
          <p>
            <strong className="text-moonbeem-ink">Entire agreement:</strong>{" "}
            These Terms, together with our{" "}
            <Link
              className="text-moonbeem-pink hover:opacity-90"
              href="/privacy-policy"
            >
              Privacy Policy
            </Link>
            , constitute the entire agreement between you and Moonbeem regarding
            the platform.
          </p>
          <p>
            <strong className="text-moonbeem-ink">Severability:</strong> If any
            provision of these Terms is held unenforceable, the remaining
            provisions will continue in full force.
          </p>
          <p>
            <strong className="text-moonbeem-ink">No waiver:</strong> Our failure
            to enforce any provision of these Terms does not constitute a waiver
            of that provision.
          </p>
          <p>
            <strong className="text-moonbeem-ink">Assignment:</strong> You may
            not assign your rights under these Terms without our written
            consent. We may assign our rights freely, including to a successor
            entity in a merger, acquisition, or sale of assets.
          </p>
          <p>
            <strong className="text-moonbeem-ink">Notices:</strong> We may send
            notices to you via the email address associated with your account or
            through the platform. You should send notices to us at <MailLink />,
            or by mail to Moonbeem, Inc., 255 Eastern Parkway, Brooklyn, NY
            11238.
          </p>
          <p>
            <strong className="text-moonbeem-ink">Relationship:</strong> Nothing
            in these Terms creates an employment, partnership, joint venture, or
            agency relationship between you and Moonbeem.
          </p>
        </Section>

        <Section heading="17. Contact">
          <p>Questions about these Terms should be directed to:</p>
          <AddressCard
            lines={[
              "Moonbeem, Inc.",
              "255 Eastern Parkway",
              "Brooklyn, NY 11238",
            ]}
            emailPrefix="Email: "
          />
        </Section>

        <p className="text-caption text-moonbeem-ink-subtle italic m-0">
          These Terms were last updated on {EFFECTIVE_DATE}.
        </p>
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

// Plain-language lead-in that opens each substantive section in the
// source document. Rendered as an italic, pink-ruled callout so it
// reads as guidance distinct from the binding legal prose below it.
function PlainSummary({ children }: { children: React.ReactNode }) {
  return (
    <p className="border-l-2 border-moonbeem-pink/30 pl-3 italic text-moonbeem-ink-muted">
      <strong className="font-medium not-italic text-moonbeem-ink">
        Plain summary:
      </strong>{" "}
      {children}
    </p>
  );
}

// mailto for the general contact alias. Used in several sections.
function MailLink() {
  return (
    <a
      className="text-moonbeem-pink hover:opacity-90"
      href="mailto:hello@moonbeem.xyz"
    >
      hello@moonbeem.xyz
    </a>
  );
}

// Tight (no inter-line gap) address block for the DMCA agent and the
// contact section. The trailing email line is always the hello@
// alias rendered as a mailto.
function AddressCard({
  lines,
  emailPrefix,
}: {
  lines: string[];
  emailPrefix: string;
}) {
  return (
    <div className="flex flex-col rounded-lg border border-white/10 bg-white/[0.02] p-4 text-body-sm not-italic">
      {lines.map((line, i) => (
        <span
          key={line}
          className={i === 0 ? "font-medium text-moonbeem-ink" : ""}
        >
          {line}
        </span>
      ))}
      <span>
        {emailPrefix}
        <MailLink />
      </span>
    </div>
  );
}
