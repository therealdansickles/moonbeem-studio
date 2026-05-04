"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

export default function RequestSubmittedToast() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [visible, setVisible] = useState(false);
  const [titleName, setTitleName] = useState<string | null>(null);

  useEffect(() => {
    if (searchParams.get("request_submitted") !== "1") return;
    const t = searchParams.get("title");
    setTitleName(t);
    setVisible(true);

    const cleanParams = new URLSearchParams(searchParams.toString());
    cleanParams.delete("request_submitted");
    cleanParams.delete("title");
    const cleanQuery = cleanParams.toString();
    router.replace(cleanQuery ? `${pathname}?${cleanQuery}` : pathname, {
      scroll: false,
    });

    const timer = setTimeout(() => setVisible(false), 6000);
    return () => clearTimeout(timer);
  }, [searchParams, pathname, router]);

  if (!visible) return null;

  const message = titleName
    ? `Your fan edit request for ${titleName} has been submitted.`
    : "Your fan edit request has been submitted.";

  return (
    <div className="fixed top-6 left-1/2 -translate-x-1/2 z-50 max-w-md w-[calc(100%-2rem)] bg-moonbeem-pink text-moonbeem-navy rounded-md px-4 py-3 text-body shadow-lg text-center">
      {message}
    </div>
  );
}
