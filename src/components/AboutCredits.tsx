import Link from "next/link";
import {
  getCinematographers,
  getComposers,
  getDirectors,
  getEditors,
  getTopCast,
  getWriters,
  type Title,
} from "@/lib/queries/titles";

type Props = {
  title: Pick<Title, "cast_members" | "crew">;
};

function PersonRow({ label, names }: { label: string; names: string[] }) {
  if (names.length === 0) return null;
  return (
    <p className="m-0">
      <span className="text-moonbeem-ink-muted">{label}: </span>
      {names.map((name, i) => (
        <span key={`${name}-${i}`}>
          <Link
            href={`/search?person=${encodeURIComponent(name)}`}
            className="text-moonbeem-ink underline-offset-2 hover:text-moonbeem-pink hover:underline transition-colors"
          >
            {name}
          </Link>
          {i < names.length - 1 && ", "}
        </span>
      ))}
    </p>
  );
}

export default function AboutCredits({ title }: Props) {
  const directors = getDirectors(title.crew);
  const writers = getWriters(title.crew);
  const cinematographers = getCinematographers(title.crew);
  const editors = getEditors(title.crew);
  const composers = getComposers(title.crew);
  const cast = getTopCast(title.cast_members, 5);

  const anyCrew =
    directors.length +
      writers.length +
      cinematographers.length +
      editors.length +
      composers.length >
    0;

  if (!anyCrew && cast.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 text-body-sm leading-relaxed max-w-prose w-full text-left">
      <PersonRow
        label={directors.length > 1 ? "Directors" : "Director"}
        names={directors}
      />
      <PersonRow
        label={writers.length > 1 ? "Writers" : "Writer"}
        names={writers}
      />
      <PersonRow
        label={
          cinematographers.length > 1 ? "Cinematographers" : "Cinematographer"
        }
        names={cinematographers}
      />
      <PersonRow
        label={editors.length > 1 ? "Editors" : "Editor"}
        names={editors}
      />
      <PersonRow
        label={composers.length > 1 ? "Composers" : "Composer"}
        names={composers}
      />
      <PersonRow label="Cast" names={cast} />
    </div>
  );
}
