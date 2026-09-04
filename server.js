const express = require("express");
const axios = require("axios");
const cron = require("node-cron");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const app = express();

app.use(express.static("."));
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY
);

const headers = {
  "User-Agent": "Mozilla/5.0"
};

const NEW_LIMIT_DAYS = 7;
const RECENT_LIMIT_DAYS = 14;

const SONG_SCAN_LIMIT = 5;
const YOUTUBE_VIDEO_SCAN_LIMIT = 5;

const GOOGLE_CLIENT_ID =
  process.env.GOOGLE_CLIENT_ID;

const GOOGLE_CLIENT_SECRET =
  process.env.GOOGLE_CLIENT_SECRET;

const APP_BASE_URL =
  process.env.APP_BASE_URL ||
  "https://surprising-mindfulness-production-b530.up.railway.app";

const GOOGLE_REDIRECT_URI =
  `${APP_BASE_URL}/auth/youtube/callback`;

const YOUTUBE_SCOPE =
  "https://www.googleapis.com/auth/youtube.readonly";

const oauthStates = new Map();


function sleep(ms) {
  return new Promise(
    resolve =>
      setTimeout(resolve, ms)
  );
}


function chunkArray(arr, size) {

  const result = [];

  for (
    let i = 0;
    i < arr.length;
    i += size
  ) {

    result.push(
      arr.slice(
        i,
        i + size
      )
    );
  }

  return result;
}


function youtubeConfigured() {

  return Boolean(
    GOOGLE_CLIENT_ID &&
    GOOGLE_CLIENT_SECRET
  );
}


// ======================================================
// SUNO 프로필 YouTube 링크
// ======================================================

const YOUTUBE_HOST_RE =
  /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com|youtu\.be)\/[^"'<>\s\\]+/gi;


function normalizeExternalUrl(raw) {

  if (!raw)
    return null;

  let url =
    String(raw)
      .replace(
        /\\u0026/g,
        "&"
      )
      .replace(
        /\\\//g,
        "/"
      )
      .replace(
        /&amp;/g,
        "&"
      )
      .trim();

  if (
    !/^https?:\/\//i.test(url)
  ) {

    url =
      "https://" + url;
  }

  try {

    const u =
      new URL(url);

    const allowedHosts = [
      "youtube.com",
      "www.youtube.com",
      "m.youtube.com",
      "youtu.be"
    ];

    if (
      !allowedHosts.includes(
        u.hostname
      )
    ) {

      return null;
    }

    return u.toString();

  } catch {

    return null;
  }
}


function extractYouTubeUrls(html) {

  const found =
    new Set();

  const decoded =
    String(html || "")
      .replace(
        /\\u0026/g,
        "&"
      )
      .replace(
        /\\\//g,
        "/"
      )
      .replace(
        /&amp;/g,
        "&"
      );

  const matches =
    decoded.match(
      YOUTUBE_HOST_RE
    ) || [];

  for (
    const raw of matches
  ) {

    const url =
      normalizeExternalUrl(
        raw
      );

    if (url) {

      found.add(url);
    }
  }

  return [...found];
}


async function getFriendYouTube(friend) {

  if (
    !friend ||
    !friend.profile_url
  ) {

    return {
      ok: false,
      id: friend?.id,
      youtube_url: null,
      urls: [],
      error:
        "profile_url_not_found"
    };
  }

  try {

    const {
      data: html
    } =
      await axios.get(
        friend.profile_url,
        {
          headers,
          timeout: 20000
        }
      );

    const urls =
      extractYouTubeUrls(
        html
      );

    return {
      ok: true,
      id:
        friend.id,
      friend:
        friend.friend_name,
      profile_url:
        friend.profile_url,
      youtube_url:
        urls[0] || null,
      urls
    };

  } catch (e) {

    return {
      ok: false,
      id:
        friend.id,
      friend:
        friend.friend_name,
      profile_url:
        friend.profile_url,
      youtube_url:
        null,
      urls: [],
      error:
        e.message
    };
  }
}


// ======================================================
// SUNO 곡 ID
// ======================================================

function extractSongIds(html) {

  const ids =
    new Set();

  let m;

  const patterns = [

    /\/song\/([a-f0-9-]{36})/g,

    /"entity_id":"([a-f0-9-]{36})"/g,

    /\\"entity_id\\":\\"([a-f0-9-]{36})\\"/g,

    /"id":"([a-f0-9-]{36})"/g,

    /\\"id\\":\\"([a-f0-9-]{36})\\"/g
  ];

  for (
    const re of patterns
  ) {

    while (
      (m = re.exec(html)) !== null
    ) {

      ids.add(
        m[1]
      );
    }
  }

  return [...ids];
}


// ======================================================
// SUNO 상태 판정
// ======================================================

function classifyTrack(
  publicAt
) {

  if (!publicAt) {

    return {
      state:
        "ARCHIVED",
      oldReason:
        "public_at_not_found"
    };
  }

  const ageDays =
    (
      Date.now() -
      new Date(
        publicAt
      ).getTime()
    ) /
    86400000;

  if (
    ageDays <=
    NEW_LIMIT_DAYS
  ) {

    return {
      state: "NEW",
      oldReason: null
    };
  }

  if (
    ageDays <=
    RECENT_LIMIT_DAYS
  ) {

    return {
      state:
        "RECENT",
      oldReason:
        null
    };
  }

  return {
    state:
      "ARCHIVED",

    oldReason:
      `older_than_${RECENT_LIMIT_DAYS}_days`
  };
}


// ======================================================
// SUNO 곡 정보
// ======================================================

async function getSongInfo(
  songUrl
) {

  let title =
    "Suno song";

  let publicAt =
    null;

  try {

    const {
      data
    } =
      await axios.get(
        songUrl,
        {
          headers,
          timeout:
            15000
        }
      );

    const og =
      data.match(
        /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i
      );

    if (og) {

      title =
        og[1]
          .replace(
            " | Suno",
            ""
          )
          .trim();
    }

    const created1 =
      data.match(
        /"created_at"\s*:\s*"([^"]+)"/i
      );

    const created2 =
      data.match(
        /\\"created_at\\"\s*:\s*\\"([^\\"]+)\\"/i
      );

    if (
      created1
    ) {

      publicAt =
        created1[1];

    } else if (
      created2
    ) {

      publicAt =
        created2[1];
    }

  } catch (e) {

    console.log(
      "song info fail:",
      songUrl,
      e.message
    );
  }

  return {
    title,
    publicAt
  };
}


// ======================================================
// SUNO 정리
// ======================================================

async function cleanupTracks() {

  const now =
    new Date();

  const readLimit =
    new Date(
      now.getTime() -
      3 *
      86400000
    ).toISOString();

  const archiveLimit =
    new Date(
      now.getTime() -
      7 *
      86400000
    ).toISOString();

  const {
    error:
      archiveError
  } =
    await supabase
      .from("tracks")
      .update({
        state:
          "ARCHIVED",

        archived_at:
          now.toISOString()
      })
      .eq(
        "state",
        "READ"
      )
      .lt(
        "read_at",
        readLimit
      );

  const {
    error:
      deleteError
  } =
    await supabase
      .from("tracks")
      .delete()
      .eq(
        "state",
        "ARCHIVED"
      )
      .lt(
        "archived_at",
        archiveLimit
      );

  return {

    ok:
      !archiveError &&
      !deleteError,

    archiveError:
      archiveError
        ?.message ||
      null,

    deleteError:
      deleteError
        ?.message ||
      null
  };
}


// ======================================================
// SUNO 친구 1명 수집
// ======================================================

async function scanFriend(
  friend
) {

  let inserted = 0;
  let newCount = 0;
  let recentCount = 0;
  let archivedOld = 0;
  let skipped = 0;

  try {

    const {
      data: html
    } =
      await axios.get(
        friend.profile_url,
        {
          headers,
          timeout:
            20000
        }
      );

    const ids =
      extractSongIds(
        html
      ).slice(
        0,
        SONG_SCAN_LIMIT
      );

    for (
      const id of ids
    ) {

      const {
        data: exists
      } =
        await supabase
          .from("tracks")
          .select("id")
          .eq(
            "track_key",
            id
          )
          .maybeSingle();

      if (exists) {

        skipped++;

        continue;
      }

      const trackUrl =
        `https://suno.com/song/${id}`;

      const info =
        await getSongInfo(
          trackUrl
        );

      const judged =
        classifyTrack(
          info.publicAt
        );

      const row = {

        track_key:
          id,

        friend_name:
          friend.friend_name,

        title:
          info.title,

        track_url:
          trackUrl,

        profile_url:
          friend.profile_url,

        group_name:
          friend.group_name,

        state:
          judged.state,

        public_at:
          info.publicAt,

        old_reason:
          judged.oldReason,

        detected_at:
          new Date()
            .toISOString()
      };

      if (
        judged.state ===
        "ARCHIVED"
      ) {

        row.archived_at =
          new Date()
            .toISOString();

        archivedOld++;
      }

      if (
        judged.state ===
        "NEW"
      ) {

        newCount++;
      }

      if (
        judged.state ===
        "RECENT"
      ) {

        recentCount++;
      }

      const {
        error
      } =
        await supabase
          .from("tracks")
          .insert(row);

      if (!error) {

        inserted++;

      } else {

        console.log(
          "insert fail:",
          friend.friend_name,
          error.message
        );
      }
    }

  } catch (e) {

    console.log(
      "scan fail:",
      friend.friend_name,
      e.message
    );
  }

  return {

    friend:
      friend.friend_name,

    inserted,

    new:
      newCount,

    recent:
      recentCount,

    archivedOld,

    skipped
  };
}


// ======================================================
// SUNO 전체 수집
// ======================================================

async function scanOnce() {

  await cleanupTracks();

  const {
    data: friends,
    error
  } =
    await supabase
      .from("friends")
      .select("*")
      .eq(
        "active",
        true
      )
      .order(
        "id",
        {
          ascending:
            true
        }
      );

  if (error) {

    throw error;
  }

  let inserted = 0;
  let newCount = 0;
  let recentCount = 0;
  let archivedOld = 0;
  let skipped = 0;

  for (
    const friend of friends
  ) {

    const r =
      await scanFriend(
        friend
      );

    inserted +=
      r.inserted;

    newCount +=
      r.new;

    recentCount +=
      r.recent;

    archivedOld +=
      r.archivedOld;

    skipped +=
      r.skipped;
  }

  return {

    ok: true,

    friends:
      friends.length,

    inserted,

    new:
      newCount,

    recent:
      recentCount,

    archivedOld,

    skipped,

    scanLimitPerFriend:
      SONG_SCAN_LIMIT,

    newLimitDays:
      NEW_LIMIT_DAYS,

    recentLimitDays:
      RECENT_LIMIT_DAYS
  };
}


// ======================================================
// OAuth
// ======================================================

function cleanupOauthStates() {

  const now =
    Date.now();

  for (
    const [
      state,
      expires
    ]
    of oauthStates.entries()
  ) {

    if (
      expires < now
    ) {

      oauthStates.delete(
        state
      );
    }
  }
}


function createOauthState() {

  cleanupOauthStates();

  const state =
    crypto
      .randomBytes(24)
      .toString("hex");

  oauthStates.set(
    state,
    Date.now() +
    600000
  );

  return state;
}


function consumeOauthState(
  state
) {

  cleanupOauthStates();

  const expires =
    oauthStates.get(
      state
    );

  if (
    !state ||
    !expires
  ) {

    return false;
  }

  oauthStates.delete(
    state
  );

  return (
    expires >=
    Date.now()
  );
}


// ======================================================
// OAuth DB
// ======================================================

async function getStoredYouTubeAuth() {

  const {
    data,
    error
  } =
    await supabase
      .from(
        "youtube_auth"
      )
      .select("*")
      .order(
        "id",
        {
          ascending:
            false
        }
      )
      .limit(1)
      .maybeSingle();

  if (error) {

    throw error;
  }

  return data || null;
}


async function saveYouTubeAuth(
  tokenData
) {

  const current =
    await getStoredYouTubeAuth();

  const refreshToken =
    tokenData.refresh_token ||
    current?.refresh_token ||
    null;

  const row = {

    access_token:
      tokenData.access_token,

    refresh_token:
      refreshToken,

    token_type:
      tokenData.token_type ||
      "Bearer",

    scope:
      tokenData.scope ||
      YOUTUBE_SCOPE,

    expiry_date:
      Date.now() +
      (
        Number(
          tokenData.expires_in ||
          3600
        ) *
        1000
      ),

    updated_at:
      new Date()
        .toISOString()
  };

  if (
    current?.id
  ) {

    const {
      error
    } =
      await supabase
        .from(
          "youtube_auth"
        )
        .update(row)
        .eq(
          "id",

          current.id
        );

    if (error) {

      throw error;
    }

  } else {

    const {
      error
    } =
      await supabase
        .from(
          "youtube_auth"
        )
        .insert({
          ...row,

          created_at:
            new Date()
              .toISOString()
        });

    if (error) {

      throw error;
    }
  }

  return row;
}


// ======================================================
// OAuth Token
// ======================================================

async function exchangeCodeForToken(
  code
) {

  const params =
    new URLSearchParams({
      client_id:
        GOOGLE_CLIENT_ID,

      client_secret:
        GOOGLE_CLIENT_SECRET,

      code,

      grant_type:
        "authorization_code",

      redirect_uri:
        GOOGLE_REDIRECT_URI
    });

  const {
    data
  } =
    await axios.post(
      "https://oauth2.googleapis.com/token",

      params.toString(),

      {
        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded"
        },

        timeout:
          20000
      }
    );

  return data;
}


async function refreshYouTubeToken(
  refreshToken
) {

  if (!refreshToken) {

    throw new Error(
      "YouTube refresh token not found"
    );
  }

  const params =
    new URLSearchParams({

      client_id:
        GOOGLE_CLIENT_ID,

      client_secret:
        GOOGLE_CLIENT_SECRET,

      refresh_token:
        refreshToken,

      grant_type:
        "refresh_token"
    });

  const {
    data
  } =
    await axios.post(
      "https://oauth2.googleapis.com/token",

      params.toString(),

      {
        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded"
        },

        timeout:
          20000
      }
    );

  return saveYouTubeAuth({

    ...data,

    refresh_token:
      refreshToken
  });
}


async function getYouTubeAccessToken() {

  if (
    !youtubeConfigured()
  ) {

    throw new Error(
      "Google OAuth 환경변수가 없습니다."
    );
  }

  let auth =
    await getStoredYouTubeAuth();

  if (!auth) {

    throw new Error(
      "YouTube 계정이 연결되지 않았습니다."
    );
  }

  if (
    auth.access_token &&
    Number(
      auth.expiry_date
    ) >
    Date.now() +
    60000
  ) {

    return auth.access_token;
  }

  auth =
    await refreshYouTubeToken(
      auth.refresh_token
    );

  return auth.access_token;
}


// ======================================================
// YouTube API
// ======================================================

async function youtubeApiGet(
  path,
  params = {}
) {

  const accessToken =
    await getYouTubeAccessToken();

  const {
    data
  } =
    await axios.get(
      `https://www.googleapis.com/youtube/v3/${path}`,

      {
        params,

        headers: {
          Authorization:
            `Bearer ${accessToken}`
        },

        timeout:
          25000
      }
    );

  return data;
}


async function youtubeApiGetWithToken(
  accessToken,
  path,
  params = {}
) {

  const {
    data
  } =
    await axios.get(
      `https://www.googleapis.com/youtube/v3/${path}`,

      {
        params,

        headers: {
          Authorization:
            `Bearer ${accessToken}`
        },

        timeout:
          25000
      }
    );

  return data;
}


// ======================================================
// 구독 목록
// ======================================================

async function fetchAllYouTubeSubscriptions() {

  const subscriptions =
    [];

  let pageToken =
    null;

  do {

    const data =
      await youtubeApiGet(
        "subscriptions",

        {
          part:
            "snippet",

          mine:
            true,

          maxResults:
            50,

          ...(
            pageToken
              ? {
                  pageToken
                }
              : {}
          )
        }
      );

    for (
      const item
      of data.items || []
    ) {

      const channelId =
        item
          ?.snippet
          ?.resourceId
          ?.channelId;

      if (!channelId) {

        continue;
      }

      subscriptions.push({

        channel_id:
          channelId,

        channel_title:
          item
            ?.snippet
            ?.title ||
          "",

        channel_url:
          `https://www.youtube.com/channel/${channelId}`,

        thumbnail_url:
          item
            ?.snippet
            ?.thumbnails
            ?.medium
            ?.url ||

          item
            ?.snippet
            ?.thumbnails
            ?.default
            ?.url ||

          null,

        subscribed_at:
          item
            ?.snippet
            ?.publishedAt ||
          null
      });
    }

    pageToken =
      data.nextPageToken ||
      null;

  } while (
    pageToken
  );

  return subscriptions;
}


// ======================================================
// 채널 상세정보
// ======================================================

async function fetchYouTubeChannelDetails(
  channelIds
) {

  const map =
    new Map();

  const batches =
    chunkArray(
      channelIds,
      50
    );

  for (
    const batch
    of batches
  ) {

    if (
      !batch.length
    ) {

      continue;
    }

    const data =
      await youtubeApiGet(
        "channels",

        {
          part:
            "snippet,contentDetails",

          id:
            batch.join(","),

          maxResults:
            50
        }
      );

    for (
      const item
      of data.items || []
    ) {

      map.set(
        item.id,

        {
          channel_id:
            item.id,

          channel_title:
            item
              ?.snippet
              ?.title ||
            "",

          channel_url:
            `https://www.youtube.com/channel/${item.id}`,

          thumbnail_url:
            item
              ?.snippet
              ?.thumbnails
              ?.medium
              ?.url ||

            item
              ?.snippet
              ?.thumbnails
              ?.default
              ?.url ||

            null,

          uploads_playlist_id:
            item
              ?.contentDetails
              ?.relatedPlaylists
              ?.uploads ||
            null
        }
      );
    }
  }

  return map;
}


// ======================================================
// V6.9 구독채널 동기화
// 기존 ON/OFF 유지
// ======================================================

async function syncYouTubeSubscriptions() {

  const subscriptions =
    await fetchAllYouTubeSubscriptions();

  const channelIds =
    subscriptions.map(
      x =>
        x.channel_id
    );

  const detailMap =
    await fetchYouTubeChannelDetails(
      channelIds
    );

  const now =
    new Date()
      .toISOString();

  const {
    data: existing,
    error:
      existingError
  } =
    await supabase
      .from(
        "youtube_channels"
      )
      .select(
        "channel_id,active"
      );

  if (
    existingError
  ) {

    throw existingError;
  }

  const activeMap =
    new Map(
      (existing || [])
        .map(
          row => [
            row.channel_id,
            row.active
          ]
        )
    );

  const rows =
    subscriptions.map(
      sub => {

        const detail =
          detailMap.get(
            sub.channel_id
          ) || {};

        return {

          ...sub,

          channel_title:
            detail.channel_title ||
            sub.channel_title,

          channel_url:
            detail.channel_url ||
            sub.channel_url,

          thumbnail_url:
            detail.thumbnail_url ||
            sub.thumbnail_url,

          uploads_playlist_id:
            detail.uploads_playlist_id ||
            null,

          detected_at:
            now,

          updated_at:
            now,

          active:
            activeMap.has(
              sub.channel_id
            )
              ?
              activeMap.get(
                sub.channel_id
              )
              :
              true
        };
      }
    );

  if (
    rows.length
  ) {

    const {
      error
    } =
      await supabase
        .from(
          "youtube_channels"
        )
        .upsert(
          rows,
          {
            onConflict:
              "channel_id"
          }
        );

    if (
      error
    ) {

      throw error;
    }
  }

  const currentIds =
    new Set(
      channelIds
    );

  const removed =
    (existing || [])
      .filter(
        row =>
          !currentIds.has(
            row.channel_id
          )
      )
      .map(
        row =>
          row.channel_id
      );

  if (
    removed.length
  ) {

    const {
      error
    } =
      await supabase
        .from(
          "youtube_channels"
        )
        .update({

          active:
            false,

          updated_at:
            now
        })
        .in(
          "channel_id",
          removed
        );

    if (
      error
    ) {

      throw error;
    }
  }

  return {

    ok: true,

    subscriptions:
      rows.length,

    deactivated:
      removed.length
  };
}


// ======================================================
// YouTube 영상 상태
// ======================================================

function classifyYouTubeVideo(
  publishedAt
) {

  if (
    !publishedAt
  ) {

    return "ARCHIVED";
  }

  const ageDays =
    (
      Date.now() -
      new Date(
        publishedAt
      ).getTime()
    ) /
    86400000;

  if (
    ageDays <=
    NEW_LIMIT_DAYS
  ) {

    return "NEW";
  }

  return "ARCHIVED";
}


// ======================================================
// YouTube 정리
// ======================================================

async function cleanupYouTubeVideos() {

  const now =
    new Date();

  const readLimit =
    new Date(
      now.getTime() -
      3 *
      86400000
    ).toISOString();

  const deleteLimit =
    new Date(
      now.getTime() -
      30 *
      86400000
    ).toISOString();

  const {
    error:
      archiveError
  } =
    await supabase
      .from(
        "youtube_videos"
      )
      .update({

        state:
          "ARCHIVED",

        archived_at:
          now.toISOString()
      })
      .eq(
        "state",
        "READ"
      )
      .lt(
        "read_at",
        readLimit
      );

  const {
    error:
      deleteError
  } =
    await supabase
      .from(
        "youtube_videos"
      )
      .delete()
      .eq(
        "state",
        "ARCHIVED"
      )
      .lt(
        "archived_at",
        deleteLimit
      );

  return {

    ok:
      !archiveError &&
      !deleteError,

    archiveError:
      archiveError
        ?.message ||
      null,

    deleteError:
      deleteError
        ?.message ||
      null
  };
}


// ======================================================
// V6.9.2 YouTube 채널 최근영상 후보 수집
// ======================================================

async function fetchYouTubeChannelCandidates(
  channel,
  accessToken
) {

  if (
    !channel.uploads_playlist_id
  ) {

    return {

      channel:
        channel.channel_title,

      rows: [],

      error:
        "uploads_playlist_id_missing"
    };
  }

  try {

    const data =
      await youtubeApiGetWithToken(
        accessToken,
        "playlistItems",
        {
          part:
            "snippet,contentDetails",

          playlistId:
            channel.uploads_playlist_id,

          maxResults:
            YOUTUBE_VIDEO_SCAN_LIMIT
        }
      );

    const rows =
      [];

    for (
      const item
      of data.items || []
    ) {

      const videoId =
        item
          ?.contentDetails
          ?.videoId ||

        item
          ?.snippet
          ?.resourceId
          ?.videoId;

      if (
        !videoId
      ) {

        continue;
      }

      const publishedAt =
        item
          ?.contentDetails
          ?.videoPublishedAt ||

        item
          ?.snippet
          ?.publishedAt ||

        null;

      const state =
        classifyYouTubeVideo(
          publishedAt
        );

      const row = {

        video_id:
          videoId,

        channel_id:
          channel.channel_id,

        channel_title:
          channel.channel_title ||

          item
            ?.snippet
            ?.videoOwnerChannelTitle ||

          "",

        title:
          item
            ?.snippet
            ?.title ||

          "YouTube video",

        video_url:
          `https://www.youtube.com/watch?v=${videoId}`,

        thumbnail_url:
          item
            ?.snippet
            ?.thumbnails
            ?.medium
            ?.url ||

          item
            ?.snippet
            ?.thumbnails
            ?.default
            ?.url ||

          null,

        published_at:
          publishedAt,

        detected_at:
          new Date()
            .toISOString(),

        state
      };

      if (
        state ===
        "ARCHIVED"
      ) {

        row.archived_at =
          new Date()
            .toISOString();
      }

      rows.push(
        row
      );
    }

    return {

      channel:
        channel.channel_title,

      rows,

      error:
        null
    };

  } catch (e) {

    return {

      channel:
        channel.channel_title,

      rows: [],

      error:
        e.response
          ?.data
          ?.error
          ?.message ||

        e.message
    };
  }
}


// ======================================================
// V6.9.2 YouTube 전체 수집
// 12채널씩 병렬 처리
// 기존 SUNO 기능은 변경하지 않음
// ======================================================

async function scanYouTubeOnce() {

  await cleanupYouTubeVideos();

  const {
    data:
      channels,

    error
  } =
    await supabase
      .from(
        "youtube_channels"
      )
      .select("*")
      .eq(
        "active",
        true
      )
      .order(
        "id",
        {
          ascending:
            true
        }
      );

  if (
    error
  ) {

    throw error;
  }

  const channelList =
    channels || [];

  const accessToken =
    await getYouTubeAccessToken();

  const batches =
    chunkArray(
      channelList,
      12
    );

  const allRows =
    [];

  let failed = 0;

  for (
    const batch
    of batches
  ) {

    const results =
      await Promise.all(
        batch.map(
          channel =>
            fetchYouTubeChannelCandidates(
              channel,
              accessToken
            )
        )
      );

    for (
      const result
      of results
    ) {

      if (
        result.error
      ) {

        failed++;

        console.log(
          "youtube channel fail:",
          result.channel,
          result.error
        );

        continue;
      }

      allRows.push(
        ...result.rows
      );
    }
  }

  const uniqueMap =
    new Map();

  for (
    const row
    of allRows
  ) {

    if (
      !uniqueMap.has(
        row.video_id
      )
    ) {

      uniqueMap.set(
        row.video_id,
        row
      );
    }
  }

  const candidates =
    [...uniqueMap.values()];

  const existingIds =
    new Set();

  const idBatches =
    chunkArray(
      candidates.map(
        row =>
          row.video_id
      ),
      200
    );

  for (
    const ids
    of idBatches
  ) {

    if (
      !ids.length
    ) {

      continue;
    }

    const {
      data:
        existingRows,

      error:
        existingError
    } =
      await supabase
        .from(
          "youtube_videos"
        )
        .select(
          "video_id"
        )
        .in(
          "video_id",
          ids
        );

    if (
      existingError
    ) {

      throw existingError;
    }

    for (
      const row
      of existingRows || []
    ) {

      existingIds.add(
        row.video_id
      );
    }
  }

  const newRows =
    candidates.filter(
      row =>
        !existingIds.has(
          row.video_id
        )
    );

  let inserted = 0;

  const insertBatches =
    chunkArray(
      newRows,
      100
    );

  for (
    const rows
    of insertBatches
  ) {

    if (
      !rows.length
    ) {

      continue;
    }

    const {
      data:
        insertedRows,

      error:
        insertError
    } =
      await supabase
        .from(
          "youtube_videos"
        )
        .insert(
          rows
        )
        .select(
          "video_id"
        );

    if (
      insertError
    ) {

      console.log(
        "youtube bulk insert fail:",
        insertError.message
      );

      failed++;

      continue;
    }

    inserted +=
      insertedRows
        ?.length ||
      rows.length;
  }

  return {

    ok:
      true,

    channels:
      channelList.length,

    inserted,

    skipped:
      candidates.length -
      newRows.length,

    failed,

    scanLimitPerChannel:
      YOUTUBE_VIDEO_SCAN_LIMIT
  };
}

// ======================================================
// HOME
// ======================================================

app.get(
  "/",
  (req, res) => {

    res.sendFile(
      __dirname +
      "/index.html"
    );
  }
);


// ======================================================
// SUNO API
// ======================================================

app.get(
  "/friends",
  async (
    req,
    res
  ) => {

    const {
      data,
      error
    } =
      await supabase
        .from("friends")
        .select("*")
        .order(
          "id",
          {
            ascending:
              true
          }
        );

    if (
      error
    ) {

      return res
        .status(500)
        .json(error);
    }

    res.json(data);
  }
);


app.get(
  "/friend-search",
  async (
    req,
    res
  ) => {

    const keyword =
      req.query.q ||
      "";

    const {
      data,
      error
    } =
      await supabase
        .from("friends")
        .select("*")
        .ilike(
          "friend_name",
          `%${keyword}%`
        )
        .order(
          "friend_name"
        );

    if (
      error
    ) {

      return res
        .status(500)
        .json(error);
    }

    res.json(data);
  }
);


app.get(
  "/friend-youtube/:id",
  async (
    req,
    res
  ) => {

    try {

      const {
        data:
          friend,

        error
      } =
        await supabase
          .from("friends")
          .select("*")
          .eq(
            "id",
            req.params.id
          )
          .single();

      if (
        error
      ) {

        throw error;
      }

      res.json(
        await getFriendYouTube(
          friend
        )
      );

    } catch (e) {

      res
        .status(500)
        .json({
          ok: false,
          error:
            e.message
        });
    }
  }
);


app.get(
  "/friends-youtube",
  async (
    req,
    res
  ) => {

    try {

      const {
        data:
          friends,

        error
      } =
        await supabase
          .from("friends")
          .select("*")
          .eq(
            "active",
            true
          )
          .order(
            "id",
            {
              ascending:
                true
            }
          );

      if (
        error
      ) {

        throw error;
      }

      const results =
        [];

      for (
        const friend
        of friends
      ) {

        results.push(
          await getFriendYouTube(
            friend
          )
        );
      }

      res.json({

        ok: true,

        friends:
          friends.length,

        found:
          results.filter(
            r =>
              r.youtube_url
          ).length,

        results
      });

    } catch (e) {

      res
        .status(500)
        .json({
          ok: false,
          error:
            e.message
        });
    }
  }
);


app.get(
  "/tracks",
  async (
    req,
    res
  ) => {

    let query =
      supabase
        .from("tracks")
        .select("*")
        .order(
          "public_at",
          {
            ascending:
              false,

            nullsFirst:
              false
          }
        )
        .order(
          "detected_at",
          {
            ascending:
              false
          }
        );

    if (
      req.query.state
    ) {

      query =
        query.eq(
          "state",
          req.query.state
        );
    }

    const {
      data,
      error
    } =
      await query;

    if (
      error
    ) {

      return res
        .status(500)
        .json(error);
    }

    res.json(data);
  }
);


app.get(
  "/mark-read/:id",
  async (
    req,
    res
  ) => {

    const {
      data,
      error
    } =
      await supabase
        .from("tracks")
        .update({

          state:
            "READ",

          read_at:
            new Date()
              .toISOString()
        })
        .eq(
          "id",
          req.params.id
        )
        .select();

    if (
      error
    ) {

      return res
        .status(500)
        .json({
          ok: false,
          error:
            error.message
        });
    }

    res.json({
      ok: true,
      data
    });
  }
);


app.get(
  "/add-friend",
  async (
    req,
    res
  ) => {

    const {
      friend_name,
      profile_url,
      group_name
    } =
      req.query;

    if (
      !friend_name ||
      !profile_url
    ) {

      return res
        .status(400)
        .json({
          ok: false,
          error:
            "friend_name/profile_url required"
        });
    }

    const {
      data,
      error
    } =
      await supabase
        .from("friends")
        .insert({

          friend_name,

          profile_url,

          group_name:
            group_name ||
            "한국",

          active:
            true
        })
        .select();

    if (
      error
    ) {

      return res
        .status(500)
        .json({
          ok: false,
          error:
            error.message
        });
    }

    res.json({
      ok: true,
      friend:
        data
    });
  }
);


app.get(
  "/delete-friend/:id",
  async (
    req,
    res
  ) => {

    const {
      data,
      error
    } =
      await supabase
        .from("friends")
        .delete()
        .eq(
          "id",
          req.params.id
        )
        .select();

    if (
      error
    ) {

      return res
        .status(500)
        .json({
          ok: false,
          error:
            error.message
        });
    }

    res.json({
      ok: true,
      deleted:
        data
    });
  }
);


app.get(
  "/toggle-friend/:id",
  async (
    req,
    res
  ) => {

    const {
      data:
        current,

      error:
        readError
    } =
      await supabase
        .from("friends")
        .select(
          "active"
        )
        .eq(
          "id",
          req.params.id
        )
        .single();

    if (
      readError
    ) {

      return res
        .status(500)
        .json({
          ok: false,
          error:
            readError.message
        });
    }

    const {
      data,
      error
    } =
      await supabase
        .from("friends")
        .update({

          active:
            !current.active
        })
        .eq(
          "id",
          req.params.id
        )
        .select();

    if (
      error
    ) {

      return res
        .status(500)
        .json({
          ok: false,
          error:
            error.message
        });
    }

    res.json({
      ok: true,
      friend:
        data
    });
  }
);


app.get(
  "/scan-friend/:id",
  async (
    req,
    res
  ) => {

    try {

      const {
        data:
          friend,

        error
      } =
        await supabase
          .from("friends")
          .select("*")
          .eq(
            "id",
            req.params.id
          )
          .single();

      if (
        error
      ) {

        throw error;
      }

      res.json({

        ok: true,

        result:
          await scanFriend(
            friend
          )
      });

    } catch (e) {

      res
        .status(500)
        .json({
          ok: false,
          error:
            e.message
        });
    }
  }
);


app.get(
  "/stats",
  async (
    req,
    res
  ) => {

    const [
      {
        count:
          newCount
      },

      {
        count:
          readCount
      },

      {
        count:
          archiveCount
      },

      {
        count:
          friendCount
      }
    ] =
      await Promise.all([

        supabase
          .from("tracks")
          .select(
            "*",
            {
              count:
                "exact",

              head:
                true
            }
          )
          .eq(
            "state",
            "NEW"
          ),

        supabase
          .from("tracks")
          .select(
            "*",
            {
              count:
                "exact",

              head:
                true
            }
          )
          .eq(
            "state",
            "READ"
          ),

        supabase
          .from("tracks")
          .select(
            "*",
            {
              count:
                "exact",

              head:
                true
            }
          )
          .eq(
            "state",
            "ARCHIVED"
          ),

        supabase
          .from("friends")
          .select(
            "*",
            {
              count:
                "exact",

              head:
                true
            }
          )
          .eq(
            "active",
            true
          )
      ]);

    res.json({

      new:
        newCount ||
        0,

      read:
        readCount ||
        0,

      archived:
        archiveCount ||
        0,

      friends:
        friendCount ||
        0
    });
  }
);


app.get(
  "/latest",
  async (
    req,
    res
  ) => {

    const {
      data,
      error
    } =
      await supabase
        .from("tracks")
        .select("*")
        .order(
          "public_at",
          {
            ascending:
              false,

            nullsFirst:
              false
          }
        )
        .order(
          "detected_at",
          {
            ascending:
              false
          }
        )
        .limit(20);

    if (
      error
    ) {

      return res
        .status(500)
        .json(error);
    }

    res.json(data);
  }
);


app.get(
  "/cleanup",
  async (
    req,
    res
  ) => {

    res.json(
      await cleanupTracks()
    );
  }
);


app.get(
  "/scan",
  async (
    req,
    res
  ) => {

    try {

      res.json(
        await scanOnce()
      );

    } catch (e) {

      res
        .status(500)
        .json({
          ok: false,
          error:
            e.message
        });
    }
  }
);


// ======================================================
// YouTube OAuth API
// ======================================================

app.get(
  "/youtube/auth/status",
  async (
    req,
    res
  ) => {

    try {

      const auth =
        await getStoredYouTubeAuth();

      res.json({

        ok: true,

        configured:
          youtubeConfigured(),

        connected:
          Boolean(
            auth &&
            auth.refresh_token
          ),

        redirect_uri:
          GOOGLE_REDIRECT_URI
      });

    } catch (e) {

      res
        .status(500)
        .json({
          ok: false,
          error:
            e.message
        });
    }
  }
);


app.get(
  "/auth/youtube",
  (
    req,
    res
  ) => {

    if (
      !youtubeConfigured()
    ) {

      return res
        .status(500)
        .send(
          "Google OAuth 환경변수가 없습니다."
        );
    }

    const state =
      createOauthState();

    const params =
      new URLSearchParams({

        client_id:
          GOOGLE_CLIENT_ID,

        redirect_uri:
          GOOGLE_REDIRECT_URI,

        response_type:
          "code",

        scope:
          YOUTUBE_SCOPE,

        access_type:
          "offline",

        include_granted_scopes:
          "true",

        prompt:
          "consent",

        state
      });

    res.redirect(
      "https://accounts.google.com/o/oauth2/v2/auth?" +
      params.toString()
    );
  }
);


app.get(
  "/auth/youtube/callback",
  async (
    req,
    res
  ) => {

    try {

      const {
        code,
        state,
        error
      } =
        req.query;

      if (
        error
      ) {

        return res
          .status(400)
          .send(
            `YouTube OAuth error: ${error}`
          );
      }

      if (
        !code ||
        !consumeOauthState(
          state
        )
      ) {

        return res
          .status(400)
          .send(
            "OAuth state가 잘못되었거나 만료되었습니다."
          );
      }

      const tokenData =
        await exchangeCodeForToken(
          code
        );

      await saveYouTubeAuth(
        tokenData
      );

      await syncYouTubeSubscriptions();

      res.redirect(
        "/?youtube=connected"
      );

    } catch (e) {

      console.log(
        "YouTube OAuth callback fail:",
        e.response
          ?.data ||
        e.message
      );

      res
        .status(500)
        .send(
          "YouTube 연결 실패: " +
          (
            e.response
              ?.data
              ?.error_description ||

            e.response
              ?.data
              ?.error ||

            e.message
          )
        );
    }
  }
);


app.get(
  "/youtube/logout",
  async (
    req,
    res
  ) => {

    try {

      const {
        error
      } =
        await supabase
          .from(
            "youtube_auth"
          )
          .delete()
          .neq(
            "id",
            0
          );

      if (
        error
      ) {

        throw error;
      }

      res.json({
        ok: true
      });

    } catch (e) {

      res
        .status(500)
        .json({
          ok: false,
          error:
            e.message
        });
    }
  }
);


// ======================================================
// YouTube 구독 동기화
// ======================================================

app.get(
  "/youtube/subscriptions/sync",
  async (
    req,
    res
  ) => {

    try {

      res.json(
        await syncYouTubeSubscriptions()
      );

    } catch (e) {

      res
        .status(500)
        .json({

          ok: false,

          error:
            e.response
              ?.data
              ?.error
              ?.message ||

            e.message
        });
    }
  }
);


// ======================================================
// V6.9 구독채널 관리
// ======================================================

app.get(
  "/youtube/channels",
  async (
    req,
    res
  ) => {

    let query =
      supabase
        .from(
          "youtube_channels"
        )
        .select("*")
        .order(
          "channel_title",
          {
            ascending:
              true
          }
        );

    if (
      req.query.active ===
      "true"
    ) {

      query =
        query.eq(
          "active",
          true
        );
    }

    const {
      data,
      error
    } =
      await query;

    if (
      error
    ) {

      return res
        .status(500)
        .json({
          ok: false,
          error:
            error.message
        });
    }

    res.json(
      data ||
      []
    );
  }
);


app.post(
  "/youtube/channels/:id/toggle",
  async (
    req,
    res
  ) => {

    try {

      const {
        data:
          current,

        error:
          readError
      } =
        await supabase
          .from(
            "youtube_channels"
          )
          .select(
            "id,active"
          )
          .eq(
            "id",
            req.params.id
          )
          .single();

      if (
        readError
      ) {

        throw readError;
      }

      const {
        data,
        error
      } =
        await supabase
          .from(
            "youtube_channels"
          )
          .update({

            active:
              !current.active,

            updated_at:
              new Date()
                .toISOString()
          })
          .eq(
            "id",
            req.params.id
          )
          .select()
          .single();

      if (
        error
      ) {

        throw error;
      }

      res.json({

        ok: true,

        channel:
          data
      });

    } catch (e) {

      res
        .status(500)
        .json({
          ok: false,
          error:
            e.message
        });
    }
  }
);


app.post(
  "/youtube/channels/set-all",
  async (
    req,
    res
  ) => {

    try {

      if (
        typeof req.body
          ?.active !==
        "boolean"
      ) {

        return res
          .status(400)
          .json({
            ok: false,
            error:
              "active boolean required"
          });
      }

      const {
        data,
        error
      } =
        await supabase
          .from(
            "youtube_channels"
          )
          .update({

            active:
              req.body.active,

            updated_at:
              new Date()
                .toISOString()
          })
          .not(
            "id",
            "is",
            null
          )
          .select(
            "id"
          );

      if (
        error
      ) {

        throw error;
      }

      res.json({

        ok: true,

        active:
          req.body.active,

        updated:
          (
            data ||
            []
          ).length
      });

    } catch (e) {

      res
        .status(500)
        .json({
          ok: false,
          error:
            e.message
        });
    }
  }
);


// ======================================================
// YouTube 영상 API
// ======================================================

app.get(
  "/youtube/videos",
  async (
    req,
    res
  ) => {

    let query =
      supabase
        .from(
          "youtube_videos"
        )
        .select("*")
        .order(
          "published_at",
          {
            ascending:
              false,

            nullsFirst:
              false
          }
        )
        .order(
          "detected_at",
          {
            ascending:
              false
          }
        );

    if (
      req.query.state
    ) {

      query =
        query.eq(
          "state",
          req.query.state
        );
    }

    const {
      data,
      error
    } =
      await query;

    if (
      error
    ) {

      return res
        .status(500)
        .json({
          ok: false,
          error:
            error.message
        });
    }

    res.json(
      data ||
      []
    );
  }
);


app.get(
  "/youtube/mark-read/:id",
  async (
    req,
    res
  ) => {

    const {
      data,
      error
    } =
      await supabase
        .from(
          "youtube_videos"
        )
        .update({

          state:
            "READ",

          read_at:
            new Date()
              .toISOString()
        })
        .eq(
          "id",
          req.params.id
        )
        .select();

    if (
      error
    ) {

      return res
        .status(500)
        .json({
          ok: false,
          error:
            error.message
        });
    }

    res.json({
      ok: true,
      data
    });
  }
);


app.get(
  "/youtube/stats",
  async (
    req,
    res
  ) => {

    const [
      {
        count:
          channelCount
      },

      {
        count:
          newCount
      },

      {
        count:
          readCount
      },

      {
        count:
          archivedCount
      }
    ] =
      await Promise.all([

        supabase
          .from(
            "youtube_channels"
          )
          .select(
            "*",
            {
              count:
                "exact",

              head:
                true
            }
          )
          .eq(
            "active",
            true
          ),

        supabase
          .from(
            "youtube_videos"
          )
          .select(
            "*",
            {
              count:
                "exact",

              head:
                true
            }
          )
          .eq(
            "state",
            "NEW"
          ),

        supabase
          .from(
            "youtube_videos"
          )
          .select(
            "*",
            {
              count:
                "exact",

              head:
                true
            }
          )
          .eq(
            "state",
            "READ"
          ),

        supabase
          .from(
            "youtube_videos"
          )
          .select(
            "*",
            {
              count:
                "exact",

              head:
                true
            }
          )
          .eq(
            "state",
            "ARCHIVED"
          )
      ]);

    res.json({

      channels:
        channelCount ||
        0,

      new:
        newCount ||
        0,

      read:
        readCount ||
        0,

      archived:
        archivedCount ||
        0
    });
  }
);


app.get(
  "/youtube/scan",
  async (
    req,
    res
  ) => {

    try {

      res.json(
        await scanYouTubeOnce()
      );

    } catch (e) {

      res
        .status(500)
        .json({

          ok: false,

          error:
            e.response
              ?.data
              ?.error
              ?.message ||

            e.message
        });
    }
  }
);


app.get(
  "/youtube/cleanup",
  async (
    req,
    res
  ) => {

    try {

      res.json(
        await cleanupYouTubeVideos()
      );

    } catch (e) {

      res
        .status(500)
        .json({
          ok: false,
          error:
            e.message
        });
    }
  }
);


// ======================================================
// 자동수집
// ======================================================

cron.schedule(
  "*/10 * * * *",
  async () => {

    try {

      console.log(
        "auto suno scan start"
      );

      await scanOnce();

    } catch (e) {

      console.log(
        "auto suno scan fail:",
        e.message
      );
    }
  }
);


cron.schedule(
  "7 * * * *",
  async () => {

    try {

      const auth =
        await getStoredYouTubeAuth();

      if (
        !auth
          ?.refresh_token
      ) {

        return;
      }

      console.log(
        "auto youtube scan start"
      );

      await scanYouTubeOnce();

    } catch (e) {

      console.log(
        "auto youtube scan fail:",
        e.response
          ?.data
          ?.error
          ?.message ||

        e.message
      );
    }
  }
);


cron.schedule(
  "17 */12 * * *",
  async () => {

    try {

      const auth =
        await getStoredYouTubeAuth();

      if (
        !auth
          ?.refresh_token
      ) {

        return;
      }

      console.log(
        "auto youtube subscription sync start"
      );

      await syncYouTubeSubscriptions();

    } catch (e) {

      console.log(
        "auto youtube subscription sync fail:",
        e.response
          ?.data
          ?.error
          ?.message ||

        e.message
      );
    }
  }
);


// ======================================================
// SERVER
// ======================================================

const PORT =
  process.env.PORT ||
  3000;


app.listen(
  PORT,
  () => {

    console.log(
      `SUNO Radar V6.9.2 Server running on ${PORT}`
    );

    console.log(
      `YouTube OAuth redirect: ${GOOGLE_REDIRECT_URI}`
    );
  }
);
