require('dotenv').config();
const express = require('express');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const admin = require('firebase-admin');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors'); // CORS ইম্পোর্ট করা হলো

const token = process.env.BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });

const app = express();
const PORT = process.env.PORT || 3000;

// Firebase Setup
const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// Middleware
app.use(cors());
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
        if (!channelsSnapshot.exists) return true; 

        const channels = channelsSnapshot.data().list || [];
        let notJoinedChannels = [];

        for (let channel of channels) {
            try {
                const chatMember = await bot.getChatMember(channel.channelId, userId);
                if (chatMember.status === 'left' || chatMember.status === 'kicked') {
                    notJoinedChannels.push(channel);
                }
            } catch (error) {
                console.log(`Error checking channel ${channel.channelId}`);
            }
        }
        return notJoinedChannels;
    } catch (error) {
        return true; 
    }
}

// =================================================================
// টেলিগ্রাম বট লজিক (/start)
// =================================================================
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
                userId, firstName, balance: 0, tasksCompleted: 0,
                completedTasks: [], referralCode, referralsCount: 0, joinedAt: new Date(),
            });
        }

        // চেক চ্যানেল সাবস্ক্রিপশন
        const notJoined = await checkForceSub(userId);

        if (notJoined !== true && notJoined.length > 0) {
            let inlineKeyboard = notJoined.map(ch => [{ text: `Join ${ch.name}`, url: ch.url }]);
            
            // WebApp Verify Button
            const verifyUrl = `https://gbuxbot.onrender.com/verify?userId=${userId}`;
            inlineKeyboard.push([{ text: "Verify Now ✅", web_app: { url: verifyUrl } }]);

            return bot.sendMessage(chatId, `👋 Hello ${firstName}!\n\n⚠️ You must join our official channels to use this bot! After joining, click the Verify Now button.`, {
                reply_markup: { inline_keyboard: inlineKeyboard }
            });
        }

        // যদি সব জয়েন থাকে
        bot.sendMessage(chatId, `🎉 Welcome back to GBuxBot, ${firstName}!`, replyKeyboard);

    } catch (error) {
        bot.sendMessage(chatId, "Sorry, something went wrong.");
    }
});

// মেনু বাটন ক্লিক হ্যান্ডলার
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    const text = msg.text;

    if (['Start Earning 💸', 'Balance 💰', 'Refer 👥', 'Ads 📊', 'Rules 📚'].includes(text)) {
        
        const notJoined = await checkForceSub(userId);
        if (notJoined !== true && notJoined.length > 0) {
            bot.sendMessage(chatId, "⚠️ You have left our channel! Please send /start to verify again.");
            return;
        }

        if (text === 'Start Earning 💸') {
            const webAppUrl = `https://gbuxbot.onrender.com/?userId=${userId}`;
            bot.sendMessage(chatId, "Click below to open the app and start earning!", {
                reply_markup: {
                    inline_keyboard: [[{ text: '🚀 Open Web App', web_app: { url: webAppUrl } }]]
                }
            });
        } else if (text === 'Balance 💰') {
            const doc = await db.collection('users').doc(userId).get();
            bot.sendMessage(chatId, `💰 Your current balance is: ${doc.exists ? doc.data().balance : 0} Bux`);
        } 
        // ... (বাকি বাটন লজিক আগের মতই)
    }
});

// =================================================================
// Verification API (WebApp থেকে কল হবে)
// =================================================================
app.get('/verify', (req, res) => {
    res.sendFile(path.join(__dirname, 'verify.html'));
});

app.post('/api/verify-channel', async (req, res) => {
    const { userId } = req.body;
    
    const notJoined = await checkForceSub(userId);
    
    if (notJoined === true || notJoined.length === 0) {
        // যদি জয়েন করে থাকে, বট মেনু পাঠাবে
        bot.sendMessage(userId, "✅ Verification Successful! Use the menu below.", replyKeyboard);
        return res.json({ success: true });
    } else {
        // যদি জয়েন না করে থাকে
        return res.json({ success: false, message: "You haven't joined all channels!" });
    }
});

// =================================================================
// Admin Panel API (আগের মতোই থাকবে)
// =================================================================
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'indexAdmin.html')));
// ... (আপনার আগের Admin API কোডগুলো এখানে রাখবেন) ...

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
