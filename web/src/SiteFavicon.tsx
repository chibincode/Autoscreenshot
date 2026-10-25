import { useState } from "react";
import { Globe2 } from "lucide-react";

export function SiteFavicon({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  let source: string | null = null;
  try {
    const site = new URL(url);
    if (site.protocol === "https:" || site.protocol === "http:") {
      source = new URL("/favicon.ico", site.origin).href;
    }
  } catch {
    // Jobs without a valid website still keep the same title alignment.
  }
  return (
    <span className="job-favicon" aria-hidden="true">
      <Globe2 />
      {source && !failed ? (
        <img src={source} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      ) : null}
    </span>
  );
}
