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

// [NEW] User state management for conversational flows
const userStates = {};

const app = express();
const PORT = process.env.PORT || 3000;

// =================================================================
// 2. Firebase Setup
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
const FieldValue = admin.firestore.FieldValue;

// =================================================================
// 3. Middleware
// =================================================================
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// =================================================================
// 4. টেলিগ্রাম বট কীবোর্ড মেনু
// =================================================================
// [MODIFIED] 'Ads 📊' বাটনটি ফিরিয়ে আনা হয়েছে।
const mainMenu = {
    reply_markup: {
        keyboard: [
            [{ text: 'Start Earning 💸' }],
            [{ text: 'Balance 💰' }, { text: 'Refer 👥' }],
            [{ text: 'Ads 📊' }, { text: 'Rules 📚' }]
        ],
        resize_keyboard: true
    }
};

const earningMenu = {
    reply_markup: {
        keyboard: [
            [{ text: '📢 Join Chats' }, { text: '🤖 Message Bots' }],
            [{ text: '🎁 Daily Claim' }, { text: '👨‍💻 Micro Tasks' }],
            [{ text: '🔙 Back' }]
        ],
        resize_keyboard: true
    }
};

// [NEW] 'Ads' বাটনের জন্য নতুন মেনু
const adsMenu = {
    reply_markup: {
        keyboard: [
            [{ text: 'Create Tasks 📝' }],
            [{ text: '🔙 Back' }]
        ],
        resize_keyboard: true
    }
};


// =================================================================
// 5. ফোর্স সাবস্ক্রাইব ফাংশন
// =================================================================
async function checkForceSub(userId) {
    try {
        const channelsSnapshot = await db.collection('settings').doc('channels').get();
        if (!channelsSnapshot.exists) return true;
        const channels = channelsSnapshot.data().list || [];
        if (channels.length === 0) return true;
        let notJoinedChannels = [];
        for (let channel of channels) {
            try {
                const chatMember = await bot.getChatMember(channel.channelId, userId);
                if (chatMember.status === 'left' || chatMember.status === 'kicked') {
                    notJoinedChannels.push(channel);
                }
            } catch (error) {
                console.log(`Error checking channel ${channel.channelId} for user ${userId}:`, error.message);
            }
        }
        return notJoinedChannels;
    } catch (error) {
        console.error("Error in checkForceSub:", error);
        return true;
    }
}


// =================================================================
// 6. টেলিগ্রাম বট লজিক (/start)
// =================================================================
bot.onText(/\/start(?: (.+))?/, async (msg, match) => {
    // ... আগের /start লজিক অপরিবর্তিত ...
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    const firstName = msg.from.first_name;
    const referrerCode = match[1];

    try {
        const userRef = db.collection('users').doc(userId);
        const doc = await userRef.get();

        if (!doc.exists) {
            const referralCode = uuidv4().split('-')[0];
            const newUser = {
                userId, firstName, balance: 0, tasksCompleted: 0, completedTasks: [],
                referralCode, referralsCount: 0, joinedAt: new Date(), referredBy: null,
                referralBonusPaid: false 
            };
            if (referrerCode) {
                const referrerQuery = await db.collection('users').where('referralCode', '==', referrerCode).limit(1).get();
                if (!referrerQuery.empty) {
                    const referrerDoc = referrerQuery.docs[0];
                    const referrerId = referrerDoc.id;
                    if (referrerId !== userId) {
                        newUser.referredBy = referrerCode;
                        const referrerRef = db.collection('users').doc(referrerId);
                        await referrerRef.update({
                            referralsCount: FieldValue.increment(1),
                            tasksCompleted: FieldValue.increment(5)
                        });
                        bot.sendMessage(referrerId, `🎉 Congratulations! A new user, ${firstName}, has joined using your referral link. You have received 5 Bux!`);
                    }
                }
            }
            await userRef.set(newUser);
        }

        const notJoined = await checkForceSub(userId);
        if (Array.isArray(notJoined) && notJoined.length > 0) {
            let inlineKeyboard = notJoined.map(ch => [{ text: `Join ${ch.name}`, url: ch.url }]);
            const verifyUrl = `https://gbuxbot.onrender.com/verify?userId=${userId}`;
            inlineKeyboard.push([{ text: "Verify Now ✅", web_app: { url: verifyUrl } }]);
            return bot.sendMessage(chatId, `👋 Hello ${firstName}!\n\n⚠️ You must join our official channels to use this bot! After joining, click the Verify Now button.`, {
                reply_markup: { inline_keyboard: inlineKeyboard }
            });
        }
        bot.sendMessage(chatId, `🎉 Welcome back to GBuxBot, ${firstName}!`, mainMenu);
    } catch (error) {
        console.error("Error in /start handler:", error);
        bot.sendMessage(chatId, "Sorry, something went wrong. Please try again later.");
    }
});


// =================================================================
// 7. মেসেজ এবং বাটন ক্লিক হ্যান্ডলার
// =================================================================
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    const text = msg.text;

    if (!text || text.startsWith('/')) return;

    // [NEW] টাস্ক তৈরির কথোপকথন হ্যান্ডেল করার জন্য
    if (userStates[userId] && userStates[userId].step) {
        return handleTaskCreation(msg);
    }

    const notJoined = await checkForceSub(userId);
    if (Array.isArray(notJoined) && notJoined.length > 0) {
        bot.sendMessage(chatId, "⚠️ You seem to have left our channel(s)! Please send /start to re-verify your membership to continue.");
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
        const balanceMsg = `💸 Your current balance is: <b>${dollarBal}$</b>\n💰 Your Bux rewards are: <b>${buxBal} Bux</b>`;
        bot.sendMessage(chatId, balanceMsg, { parse_mode: 'HTML' });
    } 
    else if (text === 'Refer 👥') {
        // ... রেফার লজিক অপরিবর্তিত ...
    }
    // [MODIFIED] 'Ads 📊' বাটনের নতুন কাজ
    else if (text === 'Ads 📊') {
        bot.sendMessage(chatId, "Here you can manage your ads or create new tasks for other users.", adsMenu);
    }
    else if (text === 'Rules 📚') {
        bot.sendMessage(chatId, "📚 Rules:\n1. Do not use multiple accounts.\n2. Complete tasks honestly.");
    }

    // Earning & Ads Menu Logic
    else if (text === 'Create Tasks 📝') {
        startTaskCreation(msg);
    }
    // ... অন্যান্য মেনু লজিক ...
    else if (text === '🔙 Back') {
        bot.sendMessage(chatId, "🏠 Returning to Main Menu...", mainMenu);
    }
});

// =================================================================
// 8. [NEW] টাস্ক তৈরির সম্পূর্ণ প্রক্রিয়া
// =================================================================
const TASK_COST_PER_USER = 0.005; // প্রতি টাস্ক পূরণের জন্য খরচ

async function startTaskCreation(msg) {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();

    const userDoc = await db.collection('users').doc(userId).get();
    const userBalance = userDoc.exists ? userDoc.data().balance : 0;

    if (userBalance < TASK_COST_PER_USER) {
        return bot.sendMessage(chatId, `❌ You don't have enough balance to create a task. The minimum cost for one user to complete a task is $${TASK_COST_PER_USER}.`);
    }

    userStates[userId] = { step: 'awaiting_bot_username', taskType: 'message_bot' };
    bot.sendMessage(chatId, "🤖 Enter the username of the bot you want users to message (e.g., `MyAwesomeBot`). Do not include the '@' symbol.", {
        reply_markup: { force_reply: true }
    });
}

async function handleTaskCreation(msg) {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    const text = msg.text.trim();
    const state = userStates[userId];

    if (!state) return;

    try {
        if (state.step === 'awaiting_bot_username') {
            state.botUsername = text.replace(/@/g, ''); // Remove @ if user adds it
            state.step = 'awaiting_target_users';
            bot.sendMessage(chatId, `✅ Bot username set to: ${state.botUsername}\n\nNow, enter how many users you want for this task. (e.g., 50)\n\nEach completion will cost you $${TASK_COST_PER_USER}.`, {
                reply_markup: { force_reply: true }
            });
        } else if (state.step === 'awaiting_target_users') {
            const targetUsers = parseInt(text, 10);
            if (isNaN(targetUsers) || targetUsers <= 0) {
                return bot.sendMessage(chatId, "❌ Please enter a valid number greater than 0.");
            }

            const totalCost = targetUsers * TASK_COST_PER_USER;
            const userDoc = await db.collection('users').doc(userId).get();
            const userBalance = userDoc.exists ? userDoc.data().balance : 0;

            if (userBalance < totalCost) {
                delete userStates[userId]; // Cancel creation
                return bot.sendMessage(chatId, `❌ Insufficient balance. You need $${totalCost.toFixed(5)}, but you only have $${userBalance.toFixed(5)}. Task creation cancelled.`);
            }

            state.targetUsers = targetUsers;
            state.totalCost = totalCost;
            state.step = 'awaiting_confirmation';

            const confirmationMsg = `📝 **Please confirm your task:**\n\n` +
                `**Type:** Message Bot\n` +
                `**Bot Username:** \`@${state.botUsername}\`\n` +
                `**Target Users:** ${state.targetUsers}\n` +
                `**Total Cost:** $${state.totalCost.toFixed(5)}\n\n` +
                `Type **yes** to confirm or **no** to cancel.`;

            bot.sendMessage(chatId, confirmationMsg, { parse_mode: 'Markdown' });
        } else if (state.step === 'awaiting_confirmation') {
            if (text.toLowerCase() === 'yes') {
                // Deduct balance and create task in DB
                const userRef = db.collection('users').doc(userId);
                await userRef.update({
                    balance: FieldValue.increment(-state.totalCost)
                });

                const taskId = uuidv4();
                await db.collection('tasks').doc(taskId).set({
                    taskId,
                    creatorId: userId,
                    taskType: state.taskType,
                    details: { botUsername: state.botUsername },
                    rewardPerUser: TASK_COST_PER_USER,
                    usersNeeded: state.targetUsers,
                    usersCompleted: 0,
                    completedBy: [],
                    status: 'active',
                    createdAt: new Date()
                });

                bot.sendMessage(chatId, "✅ Your task has been created successfully and is now active!", mainMenu);
                delete userStates[userId];
            } else {
                bot.sendMessage(chatId, "❌ Task creation cancelled.", mainMenu);
                delete userStates[userId];
            }
        }
    } catch (error) {
        console.error("Error during task creation:", error);
        bot.sendMessage(chatId, "An error occurred. Please try again.", mainMenu);
        delete userStates[userId];
    }
}


// ... আপনার বাকি কোড (Callback Query, Verification API, etc.) অপরিবর্তিত থাকবে ...
// ... শুধু নিশ্চিত করুন যে আপনার কোডের শেষে app.listen() কলটি আছে ...

// =================================================================
// 9. Verification & Admin API
// =================================================================
// ... এই অংশটি অপরিবর্তিত ...


// =================================================================
// 10. Start Server
// =================================================================
app.listen(PORT, () => {
    console.log(`✅ Server is running and listening on port ${PORT}`);
});
