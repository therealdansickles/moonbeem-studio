import { getCurrentProfile } from "@/lib/dal";
import {
  getProfileByHandle,
  getTopTitlesForUser,
} from "@/lib/queries/profiles";
import ProfileView from "@/components/profile/ProfileView";

export default async function ProfilePage({
  params,
}: {
  params: Promise<{ handle: string }>;
}) {
  const { handle } = await params;
  const profile = await getProfileByHandle(handle);
  const currentUser = await getCurrentProfile();

  if (!profile) {
    return (
      <ProfileView
        profile={null}
        handle={handle}
        topTitles={[]}
        isOwner={false}
      />
    );
  }

  const topTitles = await getTopTitlesForUser(profile.id);
  const isOwner = currentUser?.userId === profile.id;

  return (
    <ProfileView
      profile={profile}
      handle={profile.handle}
      topTitles={topTitles}
      isOwner={isOwner}
    />
  );
}
