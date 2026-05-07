require('dotenv').config();
const express = require('express');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const admin = require('firebase-admin');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');

// =================================================================
// 1. Token Check & Bot Initialization
// =================================================================
const token = process.env.BOT_TOKEN;
if (!token) {
    console.error("❌ BOT_TOKEN is missing! Please set it in Render Environment Variables.");
    process.exit(1);
}
const bot = new TelegramBot(token, { polling: true });

const app = express();
const PORT = process.env.PORT || 3000;

// =================================================================
// 2. Firebase Setup (With Error Handling)
// =================================================================
try {
    if (!process.env.FIREBASE_CREDENTIALS) {
        throw new Error("❌ FIREBASE_CREDENTIALS environment variable is missing!");
    }
    const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log("✅ Firebase initialized successfully.");
} catch (error) {
    console.error("❌ Firebase Initialization Error:", error.message);
    process.exit(1);
}
const db = admin.firestore();

// =================================================================
// 3. Middleware
// =================================================================
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// =================================================================
// 4. টেলিগ্রাম বট কীবোর্ড মেনু
// =================================================================
const mainMenu = {
    reply_markup: {
        keyboard: [
            [{ text: 'Start Earning 💸' }],[{ text: 'Balance 💰' }, { text: 'Refer 👥' }],[{ text: 'Ads 📊' }, { text: 'Rules 📚' }]
        ],
        resize_keyboard: true
    }
};

const earningMenu = {
    reply_markup: {
        keyboard: [[{ text: '📢 Join Chats' }, { text: '🤖 Message Bots' }],[{ text: '🎁 Daily Claim' }, { text: '👨‍💻 Micro Tasks' }],[{ text: '🔙 Back' }]
        ],
        resize_keyboard: true
    }
};

// =================================================================
// 5. ফোর্স সাবস্ক্রাইব (Channel Join Check) ফাংশন
// =================================================================
async function checkForceSub(userId) {
    try {
        const channelsSnapshot = await db.collection('settings').doc('channels').get();
        if (!channelsSnapshot.exists) return true; 

        const channels = channelsSnapshot.data().list || [];
        let notJoinedChannels =[];

        for (let channel of channels) {
            try {
                const chatMember = await bot.getChatMember(channel.channelId, userId);
                if (chatMember.status === 'left' || chatMember.status === 'kicked') {
                    notJoinedChannels.push(channel);
                }
            } catch (error) {
                console.log(`Error checking channel ${channel.channelId}:`, error.message);
            }
        }
        return notJoinedChannels;
    } catch (error) {
        return true; 
    }
}

// =================================================================
// 6. টেলিগ্রাম বট লজিক (/start)
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
                completedTasks:[], referralCode, referralsCount: 0, joinedAt: new Date(),
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
        bot.sendMessage(chatId, `🎉 Welcome back to GBuxBot, ${firstName}!`, mainMenu);

    } catch (error) {
        console.error(error);
        bot.sendMessage(chatId, "Sorry, something went wrong.");
    }
});

// =================================================================
// 7. মেসেজ এবং বাটন ক্লিক হ্যান্ডলার
// =================================================================
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    const text = msg.text;

    if (!text || text.startsWith('/start')) return;

    // চেক চ্যানেল সাবস্ক্রিপশন
    const notJoined = await checkForceSub(userId);
    if (notJoined !== true && notJoined.length > 0) {
        bot.sendMessage(chatId, "⚠️ You have left our channel! Please send /start to verify again.");
        return;
    }

    // Main Menu Logic
    if (text === 'Start Earning 💸') {
        bot.sendMessage(chatId, "👇 Choose an option to start earning:", earningMenu);
    } 
    else if (text === 'Balance 💰') {
        const doc = await db.collection('users').doc(userId).get();
        const data = doc.exists ? doc.data() : {};
        
        const dollarBal = (data.balance || 0).toFixed(5);
        const buxBal = (data.tasksCompleted || 0).toFixed(2);

        const balanceMsg = `💸 Your current balance is: ${dollarBal}$\n💰 Rewards is: ${buxBal}Bux`;
        bot.sendMessage(chatId, balanceMsg);
    } 
    else if (text === 'Refer 👥') {
        const doc = await db.collection('users').doc(userId).get();
        const data = doc.exists ? doc.data() : {};
        const refCode = data.referralCode || "N/A";
        const totalRefer = data.referralsCount || 0;

        const botInfo = await bot.getMe();
        const botUsername = botInfo.username;
        const referLink = `https://t.me/${botUsername}?start=${refCode}`;
        const shareText = encodeURIComponent(`Start earning with GBuxBot! Click here:`);

        const referMsg = `👥 <b>Your Referral System</b>\n\n🔗 <b>Your Link:</b> <code>${referLink}</code>\n📈 <b>Total Referrals:</b> ${totalRefer}\n\nShare your link with friends to earn more!`;

        bot.sendMessage(chatId, referMsg, {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '📋 Copy Refer link', copy_text: { text: referLink } }],[
                        { text: '📈 My Referrers', callback_data: 'my_referrers' },
                        { text: '👥 Share Refer link', url: `https://t.me/share/url?url=${encodeURIComponent(referLink)}&text=${shareText}` }
                    ]
                ]
            }
        });
    } 
    else if (text === 'Ads 📊') {
        bot.sendMessage(chatId, `<b><a href="https://t.me/RedExChangerBot/app">Exchange Cryptos to BDT</a></b>`, { parse_mode: 'HTML', disable_web_page_preview: true });
    } 
    else if (text === 'Rules 📚') {
        bot.sendMessage(chatId, "📚 Rules:\n1. Do not use multiple accounts.\n2. Complete tasks honestly.");
    }

    // Start Earning (Sub-menu) Logic
    else if (text === '📢 Join Chats') {
        bot.sendMessage(chatId, "📢 Join Chats tasks coming soon!");
    }
    else if (text === '🤖 Message Bots') {
        bot.sendMessage(chatId, "🤖 Message Bots tasks coming soon!");
    }
    else if (text === '🎁 Daily Claim') {
        bot.sendMessage(chatId, "🎁 Daily Claim coming soon!");
    }
    else if (text === '👨‍💻 Micro Tasks') {
        const webAppUrl = `https://gbuxbot.onrender.com/?userId=${userId}`;
        bot.sendMessage(chatId, "Click below to open Micro Tasks and start earning!", {
            reply_markup: {
                inline_keyboard: [[{ text: '🚀 Open Tasks Web App', web_app: { url: webAppUrl } }]]
            }
        });
    }
    else if (text === '🔙 Back') {
        bot.sendMessage(chatId, "🏠 Returning to Main Menu...", mainMenu);
    }
});

// =================================================================
// 8. ইনলাইন বাটন (Callback Query) হ্যান্ডলার
// =================================================================
bot.on('callback_query', async (query) => {
    const userId = query.from.id.toString();
    const chatId = query.message.chat.id;
    const data = query.data;

    if (data === 'my_referrers') {
        try {
            const userDoc = await db.collection('users').doc(userId).get();
            if (!userDoc.exists) return;
            const refCode = userDoc.data().referralCode;

            const refsSnapshot = await db.collection('users').where('referredBy', '==', refCode).get();
            
            if (refsSnapshot.empty) {
                bot.answerCallbackQuery(query.id, { text: "You haven't referred anyone yet!", show_alert: true });
                return;
            }

            let msgText = "📈 <b>Your Referrers List:</b>\n\n";
            let count = 1;
            refsSnapshot.forEach(doc => {
                const u = doc.data();
                msgText += `${count}. ${u.firstName} (ID: <code>${u.userId}</code>)\n`;
                count++;
            });

            bot.sendMessage(chatId, msgText, { parse_mode: 'HTML' });
            bot.answerCallbackQuery(query.id); 

        } catch (error) {
            console.error(error);
            bot.answerCallbackQuery(query.id, { text: "Error loading referrers.", show_alert: true });
        }
    }
});

// =================================================================
// 9. Verification & Admin API
// =================================================================
app.get('/verify', (req, res) => {
    res.sendFile(path.join(__dirname, 'verify.html'));
});

app.post('/api/verify-channel', async (req, res) => {
    const { userId } = req.body;
    const notJoined = await checkForceSub(userId);
    
    if (notJoined === true || notJoined.length === 0) {
        bot.sendMessage(userId, "✅ Verification Successful! Use the menu below.", mainMenu);
        return res.json({ success: true });
    } else {
        return res.json({ success: false, message: "You haven't joined all channels!" });
    }
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'indexAdmin.html'));
});

app.get('/api/admin/stats', async (req, res) => {
    try {
        const usersSnapshot = await db.collection('users').count().get();
        res.json({ totalUsers: usersSnapshot.data().count });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

app.get('/api/admin/channels', async (req, res) => {
    try {
        const doc = await db.collection('settings').doc('channels').get();
        if (!doc.exists) return res.json([]);
        res.json(doc.data().list ||
