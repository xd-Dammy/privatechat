const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');

initializeApp();
const db = getFirestore();

async function tokensForUsers(userIds) {
  const unique = [...new Set(userIds.filter(Boolean))];
  const rows = await Promise.all(unique.map(async (uid) => {
    const snap = await db.collection('users').doc(uid).collection('fcmTokens').get();
    return snap.docs.map(d => ({ uid, ref: d.ref, ...d.data() })).filter(x => x.token);
  }));
  return rows.flat();
}

async function sendPush(tokens, {title, body, url, messageId}) {
  if (!tokens.length) return;

  const messages = tokens.map(item => ({
    token: item.token,
    data: {
      title,
      body,
      messageId: String(messageId || ''),
      url: url || './app.html'
    },
    webpush: {
      headers: { Urgency: 'high' },
      fcmOptions: { link: url || './app.html' }
    }
  }));

  // FCM sendEach supports batches of up to 500 messages.
  for (let i = 0; i < messages.length; i += 500) {
    const batch = messages.slice(i, i + 500);
    const batchItems = tokens.slice(i, i + 500);
    const response = await getMessaging().sendEach(batch);

    const removals = [];
    response.responses.forEach((result, index) => {
      if (!result.success) {
        const code = result.error?.code || '';
        if (
          code.includes('registration-token-not-registered') ||
          code.includes('invalid-registration-token') ||
          code.includes('messaging/registration-token-not-registered')
        ) {
          removals.push(batchItems[index].ref.delete().catch(() => {}));
        }
      }
    });
    await Promise.all(removals);
  }
}

exports.notifyPrivateMessage = onDocumentCreated('chats/{chatId}/messages/{messageId}', async (event) => {
  const message = event.data?.data();
  if (!message || !message.recipientId || !message.senderId) return;
  if (message.senderId === message.recipientId) return;

  const senderSnap = await db.collection('users').doc(message.senderId).get();
  const sender = senderSnap.exists ? senderSnap.data() : {};
  const title = message.senderNameOverride || sender.displayName || 'PrivateChat';
  const body = message.text || (message.mediaType ? `Sent a ${message.mediaType}` : 'Sent you a message');
  const url = `./app.html?type=contact&uid=${encodeURIComponent(message.senderId)}`;

  const tokens = await tokensForUsers([message.recipientId]);
  await sendPush(tokens, { title, body, url, messageId: event.params.messageId });
});

exports.notifyGroupMessage = onDocumentCreated('groups/{groupId}/messages/{messageId}', async (event) => {
  const message = event.data?.data();
  if (!message || !message.senderId) return;

  const groupSnap = await db.collection('groups').doc(event.params.groupId).get();
  if (!groupSnap.exists) return;
  const group = groupSnap.data();
  const members = Array.isArray(group.members) ? group.members : [];
  const recipients = members.filter(uid => uid && uid !== message.senderId);
  if (!recipients.length) return;

  const senderName = message.senderName || 'A member';
  const groupName = group.name || 'Group';
  const text = message.text || (message.mediaType ? `Sent a ${message.mediaType}` : 'Sent a message');
  const title = `${senderName} · ${groupName}`;
  const body = text;
  const url = `./app.html?type=group&id=${encodeURIComponent(event.params.groupId)}`;

  const tokens = await tokensForUsers(recipients);
  await sendPush(tokens, { title, body, url, messageId: event.params.messageId });
});
