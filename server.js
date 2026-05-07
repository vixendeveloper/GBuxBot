require('dotenv').config();
const express = require('express');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const admin = require('firebase-admin');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors'); // নতুন যোগ করা হয়েছে

const token = process.env.BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });

const app = express();
const PORT = process.env.PORT || 3000;

// Firebase Setup... (আপনার আগের কোড অনুযায়ী)
const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// Middleware
app.use(cors()); // Admin panel এর জন্য
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// =================================================================
// টেলিগ্রাম বট কীবোর্ড মেনু
// =================================================================
const replyKeyboard = {
    reply_markup: {
        keyboard: [
            [{ text: 'Start Earning 💸' }],
            [{ text: 'Balance 💰' }, { text: 'Refer 👥' }],
            [{ text: 'Ads 📊' }, { text: 'Rules 📚' }]
        ],
        resize_keyboard: true
    }
};

// =================================================================
// ফোর্স সাবস্ক্রাইব (Channel Join Check) ফাংশন
// =================================================================
async function checkForceSub(userId) {
    try {
        const channelsSnapshot = await db.collection('settings').doc('channels').get();
        if (!channelsSnapshot.exists) return true; // যদি কোনো চ্যানেল সেট করা না থাকে

        const channels = channelsSnapshot.data().list || [];
        let notJoinedChannels = [];

        for (let channel of channels) {
            try {
                // বটকে অবশ্যই চ্যানেলের অ্যাডমিন হতে হবে
                const chatMember = await bot.getChatMember(channel.channelId, userId);
                if (chatMember.status === 'left' || chatMember.status === 'kicked') {
                    notJoinedChannels.push(channel);
                }
            } catch (error) {
                console.log(`Error checking channel ${channel.channelId}:`, error.message);
                // চ্যানেল না পেলে বা বট অ্যাডমিন না থাকলে এটি স্কিপ করবে
            }
        }

        return notJoinedChannels;
    } catch (error) {
        console.error("Force Sub Check Error:", error);
        return true; 
    }
}

// =================================================================
// টেলিগ্রাম বট লজিক
// =================================================================

// '/start' কমান্ড হ্যান্ডলার
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    const firstName = msg.from.first_name;

    try {
        const userRef = db.collection('users').doc(userId);
        const doc = await userRef.get();

        if (!doc.exists) {
            const referralCode = uuidv4().split('-')[0];
            await userRef.set({
                userId: userId,
                firstName: firstName,
                balance: 0,
                tasksCompleted: 0,
                completedTasks: [],
                referralCode: referralCode,
                referralsCount: 0,
                joinedAt: new Date(),
            });
        }

        const welcomeMessage = `🎉 Welcome to GBuxBot, ${firstName}!\n\nUse the menu below to navigate.`;
        bot.sendMessage(chatId, welcomeMessage, replyKeyboard);

    } catch (error) {
        bot.sendMessage(chatId, "Sorry, something went wrong.");
    }
});

// মেনু বাটন ক্লিক হ্যান্ডলার
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    const text = msg.text;

    // যদি ইউজার মেনুর কোনো বাটনে ক্লিক করে
    if (['Start Earning 💸', 'Balance 💰', 'Refer 👥', 'Ads 📊', 'Rules 📚'].includes(text)) {
        
        // আগে চেক করবে চ্যানেলগুলোতে জয়েন আছে কিনা
        const notJoined = await checkForceSub(userId);

        if (notJoined !== true && notJoined.length > 0) {
            // যদি জয়েন না থাকে, জয়েন করতে বলবে
            let inlineKeyboard = notJoined.map(ch => [{ text: `Join ${ch.name}`, url: ch.url }]);
            inlineKeyboard.push([{ text: "✅ I have Joined", callback_data: "check_join" }]);

            return bot.sendMessage(chatId, "⚠️ You must join our official channels to use this bot!", {
                reply_markup: { inline_keyboard: inlineKeyboard }
            });
        }

        // যদি সব চ্যানেলে জয়েন থাকে, তবে বাটনের কাজ করবে
        if (text === 'Start Earning 💸') {
            const webAppUrl = `https://gbuxbot.onrender.com/?userId=${userId}`;
            bot.sendMessage(chatId, "Click below to open the app and start earning!", {
                reply_markup: {
                    inline_keyboard: [[{ text: '🚀 Open Web App', web_app: { url: webAppUrl } }]]
                }
            });
        } else if (text === 'Balance 💰') {
            const doc = await db.collection('users').doc(userId).get();
            const bal = doc.exists ? doc.data().balance : 0;
            bot.sendMessage(chatId, `💰 Your current balance is: ${bal} Bux`);
        } else if (text === 'Refer 👥') {
            const doc = await db.collection('users').doc(userId).get();
            const refCode = doc.exists ? doc.data().referralCode : "N/A";
            bot.sendMessage(chatId, `👥 Your Referral Code: ${refCode}\nShare this with your friends to earn!`);
        } else if (text === 'Ads 📊') {
            bot.sendMessage(chatId, "📊 Ads section coming soon!");
        } else if (text === 'Rules 📚') {
            bot.sendMessage(chatId, "📚 Rules: Do not use multiple accounts. Complete tasks honestly.");
        }
    }
});

// "I have Joined" বাটনের ক্লিক হ্যান্ডলার
bot.on('callback_query', async (query) => {
    if (query.data === 'check_join') {
        const userId = query.from.id.toString();
        const chatId = query.message.chat.id;
        
        const notJoined = await checkForceSub(userId);
        if (notJoined === true || notJoined.length === 0) {
            bot.sendMessage(chatId, "✅ Thank you for joining! You can now use the bot.", replyKeyboard);
        } else {
            bot.answerCallbackQuery(query.id, { text: "❌ You haven't joined all channels yet!", show_alert: true });
        }
    }
});

// =================================================================
// Admin Panel API (নতুন যোগ করা হয়েছে)
// =================================================================

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'indexAdmin.html'));
});

// মোট ইউজার সংখ্যা দেখা
app.get('/api/admin/stats', async (req, res) => {
    try {
        const usersSnapshot = await db.collection('users').count().get();
        res.json({ totalUsers: usersSnapshot.data().count });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

// বাধ্যতামূলক চ্যানেলগুলো দেখা
app.get('/api/admin/channels', async (req, res) => {
    try {
        const doc = await db.collection('settings').doc('channels').get();
        if (!doc.exists) return res.json([]);
        res.json(doc.data().list || []);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch channels' });
    }
});

// নতুন চ্যানেল অ্যাড করা
app.post('/api/admin/channels', async (req, res) => {
    const { name, channelId, url } = req.body;
    try {
        const channelRef = db.collection('settings').doc('channels');
        await channelRef.set({
            list: admin.firestore.FieldValue.arrayUnion({ name, channelId, url })
        }, { merge: true });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to add channel' });
    }
});

// চ্যানেল ডিলিট করা
app.post('/api/admin/channels/delete', async (req, res) => {
    const channelObj = req.body; // { name, channelId, url }
    try {
        const channelRef = db.collection('settings').doc('channels');
        await channelRef.update({
            list: admin.firestore.FieldValue.arrayRemove(channelObj)
        });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Failed to remove channel' });
    }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
