// Must be the FIRST import so env vars are loaded before "@/db/drizzle" reads them
import "dotenv/config";
import { google, youtube_v3 } from "googleapis";
import { db } from "@/db/drizzle";
import { courses, lessons } from "@/db/schema";

const youtube = google.youtube({
  version: "v3",
  auth: process.env.YOUTUBE_API_KEY,
});

// Configuration
const CHANNEL_ID = process.env.YOUTUBE_CHANNEL_ID;
const BATCH_SIZE = 50; // Max items per API call

type Difficulty = "beginner" | "intermediate" | "advanced";

// Decide difficulty from the playlist title
function determineDifficulty(title: string): Difficulty {
  const t = title.toLowerCase();

  const beginnerKeywords = [
    "beginner",
    "basics",
    "basic",
    "introduction",
    "intro",
    "getting started",
    "crash course",
    "for dummies",
    "from scratch",
    "fundamentals",
  ];
  const advancedKeywords = [
    "advanced",
    "expert",
    "mastery",
    "masterclass",
    "deep dive",
    "architecture",
    "system design",
    "microservices",
    "performance",
    "optimization",
    "internals",
  ];
  const intermediateKeywords = [
    "intermediate",
    "project",
    "build",
    "full stack",
    "fullstack",
    "api",
    "authentication",
    "testing",
    "deployment",
    "real world",
    "real-world",
  ];

  const matches = (keywords: string[]) => keywords.some((k) => t.includes(k));

  if (matches(beginnerKeywords)) return "beginner";
  if (matches(advancedKeywords)) return "advanced";
  if (matches(intermediateKeywords)) return "intermediate";

  // Default: the generated descriptions are written for beginners
  return "beginner";
}

// Estimated total duration in minutes (assuming ~15 min per video)
function calculateDuration(videoCount: number): number {
  return videoCount * 15;
}

// Calculate course points based on difficulty and video count
function calculatePoints(difficulty: Difficulty, videoCount: number): number {
  const basePoints =
    difficulty === "beginner"
      ? 500
      : difficulty === "intermediate"
        ? 750
        : 1000;
  return basePoints + videoCount * 10;
}

// Fetch all playlists from the channel
async function fetchChannelPlaylists(): Promise<youtube_v3.Schema$Playlist[]> {
  if (!CHANNEL_ID) {
    throw new Error("YOUTUBE_CHANNEL_ID is not set in .env");
  }

  console.log("📺 Fetching playlists from channel...");

  const allPlaylists: youtube_v3.Schema$Playlist[] = [];
  let pageToken: string | undefined;

  do {
    const response = await youtube.playlists.list({
      part: ["snippet", "contentDetails"],
      channelId: CHANNEL_ID,
      maxResults: BATCH_SIZE,
      pageToken,
    });

    const playlists = response.data.items ?? [];
    allPlaylists.push(...playlists);
    pageToken = response.data.nextPageToken ?? undefined;

    console.log(`  Found ${playlists.length} playlists...`);
  } while (pageToken);

  console.log(`✅ Total playlists found: ${allPlaylists.length}\n`);
  return allPlaylists;
}

// Fetch all videos in a playlist
async function fetchPlaylistVideos(
  playlistId: string,
  playlistTitle: string,
): Promise<youtube_v3.Schema$PlaylistItem[]> {
  console.log(`  📹 Fetching videos for: ${playlistTitle}`);

  const allVideos: youtube_v3.Schema$PlaylistItem[] = [];
  let pageToken: string | undefined;

  do {
    const response = await youtube.playlistItems.list({
      part: ["snippet", "contentDetails"],
      playlistId,
      maxResults: BATCH_SIZE,
      pageToken,
    });

    allVideos.push(...(response.data.items ?? []));
    pageToken = response.data.nextPageToken ?? undefined;
  } while (pageToken);

  // Drop private/deleted videos and anything without a video id
  const available = allVideos.filter((video) => {
    const title = video.snippet?.title;
    return (
      !!video.contentDetails?.videoId &&
      title !== "Private video" &&
      title !== "Deleted video"
    );
  });

  console.log(`    ✅ Found ${available.length} videos`);
  return available;
}

// Seed courses into database
async function seedCoursesFromPlaylists() {
  console.log("🚀 Starting YouTube content import...\n");

  // 1. Fetch all playlists
  const playlists = await fetchChannelPlaylists();

  // 2. Filter out system playlists (uploads, liked, etc.)
  const coursePlaylists = playlists.filter((playlist) => {
    const title = playlist.snippet?.title ?? "";
    const isSystemPlaylist =
      title === "Uploads" || title === "Liked videos" || title === "Favorites";
    return !isSystemPlaylist;
  });

  console.log(`📚 Processing ${coursePlaylists.length} course playlists...\n`);

  let coursesAdded = 0;
  let lessonsAdded = 0;

  // 3. Process each playlist as a course
  for (const playlist of coursePlaylists) {
    const { id: playlistId, snippet, contentDetails } = playlist;

    if (!playlistId || !snippet) {
      console.log("⚠️  Skipping playlist with missing id/snippet");
      continue;
    }

    const title = snippet.title || "Untitled Course";
    const description =
      snippet.description ||
      `Complete ${title} course for beginners. Learn ${title.toLowerCase()} with practical examples and hands-on projects.`;
    const videoCount = contentDetails?.itemCount ?? 0;
    const thumbnail =
      snippet.thumbnails?.high?.url ?? snippet.thumbnails?.default?.url ?? null;

    const difficulty = determineDifficulty(title);
    const duration = calculateDuration(videoCount);
    const points = calculatePoints(difficulty, videoCount);

    console.log(`📖 Processing course: ${title}`);
    console.log(
      `    Videos: ${videoCount}, Difficulty: ${difficulty}, XP: ${points}`,
    );

    // Check if course already exists
    const existingCourse = await db.query.courses.findFirst({
      where: (courses, { eq }) => eq(courses.title, title),
    });

    if (existingCourse) {
      console.log(`    ⏭️  Course already exists, skipping...\n`);
      continue;
    }

    // Insert course
    const [course] = await db
      .insert(courses)
      .values({
        title: title,
        description: description,
        difficulty: difficulty,
        duration: duration,
        points: points,
        thumbnail: thumbnail,
      })
      .returning();

    coursesAdded++;

    // Fetch videos for this playlist
    const videos = await fetchPlaylistVideos(playlistId, title);

    // Insert lessons
    if (videos.length > 0) {
      const lessonValues = videos.map((video, index) => ({
        title: video.snippet?.title || `Lesson ${index + 1}`,
        content:
          video.snippet?.description ||
          `Watch this video to learn ${title.toLowerCase()}. Complete tutorial with practical examples.`,
        videoUrl: `https://www.youtube.com/watch?v=${video.contentDetails?.videoId}`,
        order: index + 1,
        courseId: course.id,
      }));

      await db.insert(lessons).values(lessonValues);
      lessonsAdded += lessonValues.length;
    }

    console.log(`    ✅ Added ${videos.length} lessons\n`);
  }

  console.log("✨ Import complete!");
  console.log(`   📚 Courses added: ${coursesAdded}`);
  console.log(`   📹 Lessons added: ${lessonsAdded}`);
}

// Run the import
seedCoursesFromPlaylists()
  .then(() => {
    console.log("\n✅ YouTube content import finished!");
    process.exit(0);
  })
  .catch((error) => {
    console.error("❌ Import failed:", error);
    process.exit(1);
  });
