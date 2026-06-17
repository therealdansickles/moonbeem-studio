import { getCurrentProfile } from "@/lib/dal";
import {
  getProfileByHandle,
  getTopTitlesForUser,
} from "@/lib/queries/profiles";
import { getFanEditsForCreator } from "@/lib/queries/titles";
import { getPublicDiaryForCreator } from "@/lib/queries/diary";
import { getPublicListsForCreator } from "@/lib/queries/lists";
import { getWatchedCountForCreator } from "@/lib/queries/watched";
import ProfileView from "@/components/profile/ProfileView";

export default async function ProfilePage({
  params,
}: {
  params: Promise<{ handle: string }>;
}) {
  const { handle } = await params;
  const profile = await getProfileByHandle(handle);
  const currentUser = await getCurrentProfile();

  // Stubs (creators row exists, no linked user) render the same
  // unclaimed-handle UI as 404s for now. Stage 3 will surface
  // auto-imported fan_edits on stub pages.
  if (!profile || profile.is_stub || !profile.user_id) {
    return (
      <ProfileView
        profile={null}
        handle={profile?.handle ?? handle}
        topTitles={[]}
        diary={[]}
        lists={[]}
        fanEdits={[]}
        watchedCount={0}
        isOwner={false}
      />
    );
  }

  const [topTitles, fanEdits, diary, lists, watchedCount] = await Promise.all([
    getTopTitlesForUser(profile.user_id),
    getFanEditsForCreator(profile.creator_id),
    getPublicDiaryForCreator(profile.creator_id, 20, !!currentUser),
    getPublicListsForCreator(profile.creator_id),
    getWatchedCountForCreator(profile.creator_id),
  ]);
  const isOwner = currentUser?.userId === profile.user_id;

  return (
    <ProfileView
      profile={profile}
      handle={profile.handle}
      topTitles={topTitles}
      diary={diary}
      lists={lists}
      fanEdits={fanEdits}
      watchedCount={watchedCount}
      isOwner={isOwner}
    />
  );
}
