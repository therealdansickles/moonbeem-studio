type Props = {
  searchParams: Promise<{ ok?: string; invalid?: string }>;
};

export default async function UnsubscribePage({ searchParams }: Props) {
  const params = await searchParams;
  const ok = params.ok === "1";
  const invalid = params.invalid === "1";

  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-6 px-6 bg-[radial-gradient(ellipse_at_center,_#011754_0%,_#121212_100%)]">
      <h1 className="font-wordmark text-display-md text-moonbeem-pink m-0">
        moonbeem.
      </h1>
      {ok && (
        <p className="text-body-lg text-moonbeem-ink-muted text-center max-w-md">
          You have been unsubscribed from title-update emails. You can re-enable
          them anytime from your account settings.
        </p>
      )}
      {invalid && (
        <p className="text-body-lg text-moonbeem-magenta text-center max-w-md">
          That unsubscribe link is no longer valid. If you keep getting emails,
          contact us.
        </p>
      )}
      {!ok && !invalid && (
        <p className="text-body-lg text-moonbeem-ink-muted text-center max-w-md">
          Use the link in your email to unsubscribe.
        </p>
      )}
    </div>
  );
}
