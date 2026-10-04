const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");

const { initializeApp } = require("firebase-admin/app");
const {
  getFirestore,
  FieldValue,
  Timestamp
} = require("firebase-admin/firestore");

initializeApp();

const db = getFirestore();

/* =========================
   ADMIN CHECK
========================= */

async function isAdmin(uid) {
  if (!uid) return false;

  const adminRef = db.doc(`admins/${uid}`);
  const adminSnap = await adminRef.get();

  if (!adminSnap.exists) return false;

  const data = adminSnap.data();

  return (
    data.active === true &&
    data.role === "admin"
  );
}

/* =========================
   BAN / UNBAN PLAYER
========================= */

exports.setPlayerBan = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError(
      "unauthenticated",
      "Login required"
    );
  }

  if (!(await isAdmin(request.auth.uid))) {
    throw new HttpsError(
      "permission-denied",
      "Admin only"
    );
  }

  const { uid, banned } = request.data || {};

  if (
    typeof uid !== "string" ||
    typeof banned !== "boolean"
  ) {
    throw new HttpsError(
      "invalid-argument",
      "Invalid player data"
    );
  }

  if (uid === request.auth.uid) {
    throw new HttpsError(
      "failed-precondition",
      "You cannot ban yourself"
    );
  }

  const playerRef = db.doc(`players/${uid}`);
  const playerSnap = await playerRef.get();

  if (!playerSnap.exists) {
    throw new HttpsError(
      "not-found",
      "Player not found"
    );
  }

  await playerRef.update({
    banned,
    updatedAt: FieldValue.serverTimestamp()
  });

  await db.collection("auditLogs").add({
    adminUid: request.auth.uid,
    action: banned ? "ban" : "unban",
    targetUid: uid,
    createdAt: FieldValue.serverTimestamp()
  });

  return {
    ok: true,
    banned
  };
});

/* =========================
   FUND / ADJUST PLAYER MONEY
========================= */

exports.addGameMoney = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError(
      "unauthenticated",
      "Login required"
    );
  }

  if (!(await isAdmin(request.auth.uid))) {
    throw new HttpsError(
      "permission-denied",
      "Admin only"
    );
  }

  const {
    uid,
    amount,
    reason
  } = request.data || {};

  if (
    typeof uid !== "string" ||
    typeof amount !== "number" ||
    !Number.isFinite(amount)
  ) {
    throw new HttpsError(
      "invalid-argument",
      "Invalid money data"
    );
  }

  if (Math.abs(amount) > 100000000) {
    throw new HttpsError(
      "invalid-argument",
      "Amount is too large"
    );
  }

  const playerRef = db.doc(`players/${uid}`);
  const playerSnap = await playerRef.get();

  if (!playerSnap.exists) {
    throw new HttpsError(
      "not-found",
      "Player not found"
    );
  }

  const player = playerSnap.data();

  const before = Number(player.money || 0);

  const change = Math.trunc(amount);

  const after = Math.max(
    0,
    before + change
  );

  await playerRef.update({
    money: after,
    updatedAt: FieldValue.serverTimestamp()
  });

  await db.collection("transactions").add({
    uid,
    amount: change,
    before,
    after,
    reason: String(
      reason || "Admin adjustment"
    ).slice(0, 200),
    adminUid: request.auth.uid,
    createdAt: FieldValue.serverTimestamp()
  });

  await db.collection("auditLogs").add({
    adminUid: request.auth.uid,
    action: "money_adjustment",
    targetUid: uid,
    amount: change,
    before,
    after,
    createdAt: FieldValue.serverTimestamp()
  });

  return {
    ok: true,
    before,
    after,
    amount: change
  };
});

/* =========================
   ARREST PLAYER
========================= */

exports.arrestPlayer = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError(
      "unauthenticated",
      "Login required"
    );
  }

  if (!(await isAdmin(request.auth.uid))) {
    throw new HttpsError(
      "permission-denied",
      "Admin only"
    );
  }

  const {
    uid,
    durationMinutes,
    reason
  } = request.data || {};

  if (
    typeof uid !== "string" ||
    !uid
  ) {
    throw new HttpsError(
      "invalid-argument",
      "Invalid player UID"
    );
  }

  if (uid === request.auth.uid) {
    throw new HttpsError(
      "failed-precondition",
      "You cannot arrest yourself"
    );
  }

  if (
    !Number.isFinite(durationMinutes) ||
    durationMinutes < 1 ||
    durationMinutes > 1440
  ) {
    throw new HttpsError(
      "invalid-argument",
      "Duration must be between 1 and 1440 minutes"
    );
  }

  const cleanReason = String(
    reason || ""
  ).trim();

  if (
    !cleanReason ||
    cleanReason.length > 200
  ) {
    throw new HttpsError(
      "invalid-argument",
      "Enter a valid arrest reason"
    );
  }

  const playerRef = db.doc(`players/${uid}`);
  const playerSnap = await playerRef.get();

  if (!playerSnap.exists) {
    throw new HttpsError(
      "not-found",
      "Player not found"
    );
  }

  const player = playerSnap.data();

  if (player.banned === true) {
    throw new HttpsError(
      "failed-precondition",
      "Player is banned"
    );
  }

  if (player.arrested === true) {
    throw new HttpsError(
      "failed-precondition",
      "Player is already arrested"
    );
  }

  const now = Timestamp.now();

  const minutes =
    Math.trunc(durationMinutes);

  const jailUntil =
    Timestamp.fromMillis(
      now.toMillis() +
      minutes * 60 * 1000
    );

  await playerRef.update({
    arrested: true,
    arrestReason: cleanReason,
    arrestedAt: now,
    jailUntil,
    jailLocation: "Lagos Police Station",
    updatedAt: FieldValue.serverTimestamp()
  });

  await db.collection("auditLogs").add({
    adminUid: request.auth.uid,
    action: "arrest",
    targetUid: uid,
    reason: cleanReason,
    durationMinutes: minutes,
    createdAt: FieldValue.serverTimestamp()
  });

  return {
    ok: true,
    jailUntil: jailUntil.toMillis()
  };
});

/* =========================
   RELEASE PLAYER
========================= */

exports.releasePlayer = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError(
      "unauthenticated",
      "Login required"
    );
  }

  if (!(await isAdmin(request.auth.uid))) {
    throw new HttpsError(
      "permission-denied",
      "Admin only"
    );
  }

  const { uid } = request.data || {};

  if (
    typeof uid !== "string" ||
    !uid
  ) {
    throw new HttpsError(
      "invalid-argument",
      "Invalid player UID"
    );
  }

  const playerRef = db.doc(`players/${uid}`);
  const playerSnap = await playerRef.get();

  if (!playerSnap.exists) {
    throw new HttpsError(
      "not-found",
      "Player not found"
    );
  }

  await playerRef.update({
    arrested: false,
    arrestReason: "",
    arrestedAt: null,
    jailUntil: null,
    jailLocation: null,
    updatedAt: FieldValue.serverTimestamp()
  });

  await db.collection("auditLogs").add({
    adminUid: request.auth.uid,
    action: "release",
    targetUid: uid,
    createdAt: FieldValue.serverTimestamp()
  });

  return {
    ok: true
  };
});

/* =========================
   CHAT MODERATION
========================= */

exports.onChatMessage = onDocumentCreated(
  "chat/{id}",
  async (event) => {
    const data = event.data?.data();

    if (!data) return;

    const text = String(
      data.text || ""
    ).trim();

    if (text.length > 500) {
      await event.data.ref.delete();
    }
  }
);
