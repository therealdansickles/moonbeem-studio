// /me/privacy-settings — standalone consent management page.
//
// The consent banner only shows pre-decision; once a visitor has
// accepted or rejected, there was no in-product surface to revisit
// the choice. This page is that surface. It works for anonymous and
// signed-in visitors alike — consent lives in the mb_consent cookie
// (mirrored to the account when signed in), so no auth gate.
//
// Server component for metadata only; the interactive surface is the
// "use client" PrivacySettingsClient, which reads useConsent() from
// the provider already mounted in the root layout.

import type { Metadata } from "next";
import PrivacySettingsClient from "./PrivacySettingsClient";

export const metadata: Metadata = {
  title: "Privacy settings · Moonbeem",
  description:
    "Manage what Moonbeem measures while you browse — analytics and session recording — any time.",
  robots: { index: false, follow: false },
};

export default function PrivacySettingsPage() {
  return <PrivacySettingsClient />;
}
