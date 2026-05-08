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

// User state management for conversational flows
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
const mainMenu = {
    reply_markup: {
        keyboard: [
            [{ text: 'Balance 💰' }, { text: 'Refer 👥' }],
            [{ text: 'Ads 📊' }, { text: 'Payout 💸 / Deposit 💰' }], // Payout and Deposit side-by-side
            [{ text: 'Rules 📚' }]
        ],
        resize_keyboard: true
    }
};

const earningMenu = {
    reply_markup: {
        keyboard: [
            [{ text: '📢 Join Chat Ads' }, { text: '🤖 Message Bot Ads' }],
            [{ text: '👨‍💻 Micro Task Ads' }, { text: '📨 Brodcast Ads' }], // New options for Ads
            [{ text: '🔙 Back' }]
        ],
        resize_keyboard: true
    }
};

const adsMenu = {
    reply_markup: {
        keyboard: [
            [{ text: 'Create Tasks 📝' }], // This will be handled by specific Ads types
            [{ text: '🔙 Back' }]
        ],
        resize_keyboard: true
    }
};

// Helper to get user data
async function getUserData(userId) {
    const userRef = db.collection('users').doc(userId);
    const doc = await userRef.get();
    return doc.exists ? doc.data() : null;
}

// Function to create inline button for Copy Text
function createCopyButton(text, payload) {
    return {
        text: text,
        url: `https://t.me/share/url?url=${encodeURIComponent(payload)}&text=${encodeURIComponent(`Copy this: ${payload}`)}`
    };
}


// =================================================================
// 5. ফোর্স সাবস্ক্রাইব ফাংশন
// =================================================================
async function checkForceSub(userId) {
    try {
        const settingsRef = db.collection('settings').doc('channels');
        const channelsSnapshot = await settingsRef.get();
        if (!channelsSnapshot.exists) return true; // If no settings, assume no force subscribe
        const channelsData = channelsSnapshot.data();
        const channels = channelsData.list || [];

        if (channels.length === 0) return true; // No channels to subscribe to

        let notJoinedChannels = [];
        for (const channel of channels) {
            try {
                const chatMember = await bot.getChatMember(channel.channelId, userId);
                if (chatMember.status === 'left' || chatMember.status === 'kicked') {
                    notJoinedChannels.push(channel);
                }
            } catch (error) {
                console.error(`Error checking channel ${channel.channelId} for user ${userId}:`, error.message);
                // If fetching fails, assume the user might not be joined or there's an issue with the bot's access
                // Forcing them to re-verify might be a safe approach
                notJoinedChannels.push(channel);
            }
        }
        return notJoinedChannels;
    } catch (error) {
        console.error("Error in checkForceSub:", error);
        // If there's an error, return true to indicate a problem that needs resolution, or assume they haven't joined.
        return true;
    }
}


// =================================================================
// 6. টেলিগ্রাম বট লজিক (/start)
// =================================================================
bot.onText(/\/start(?: (.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    const firstName = msg.from.first_name;
    const referrerCode = match[1];

    try {
        const userRef = db.collection('users').doc(userId);
        const doc = await userRef.get();

        // Check for force subscribe channels first
        const notJoined = await checkForceSub(userId);
        if (Array.isArray(notJoined) && notJoined.length > 0) {
            let inlineKeyboard = notJoined.map(ch => [{ text: `Join ${ch.name}`, url: ch.url }]);
            // Check if verify.html is accessible and ready
            const verifyUrl = `https://your-domain.com/verify.html?userId=${userId}`; // Replace your-domain.com
            inlineKeyboard.push([{ text: "Verify Now ✅", web_app: { url: verifyUrl } }]);
            return bot.sendMessage(chatId, `👋 Hello ${firstName}!\n\n⚠️ You must join our official channels to use this bot! After joining, click the Verify Now button.`, {
                reply_markup: { inline_keyboard: inlineKeyboard }
            });
        }

        // If all channels are joined, proceed with user creation/greeting
        if (!doc.exists) {
            const referralCode = uuidv4().split('-')[0];
            const newUser = {
                userId, firstName, balance: 0, tasksCompleted: 0, completedTasks: [],
                referralCode, referralsCount: 0, joinedAt: new Date(), referredBy: null,
                referralBonusPaid: false,
                // Add fields for tasks
                tasksCreated: 0,
                referralCommission: 0,
                // Add fields for Payout/Deposit
                usdtAddress: null,
                balanceUsd: 0 // For actual dollar balance, separate from Bux
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
                            // referrer bonus logic here
                        });
                        // Send a notification to the referrer
                        try {
                            await bot.sendMessage(referrerId, `🎉 Congratulations! A new user, ${firstName}, has joined using your referral link. You have earned a bonus!`);
                        } catch (err) {
                            console.error(`Error sending message to referrer ${referrerId}:`, err.message);
                        }
                    }
                }
            }
            await userRef.set(newUser);
            bot.sendMessage(chatId, `🎉 Welcome to GBuxBot, ${firstName}! Your journey to earning starts now!`, mainMenu);
        } else {
            bot.sendMessage(chatId, `👋 Welcome back to GBuxBot, ${firstName}!`, mainMenu);
        }
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

    // Force Subscribe Check for all messages
    const notJoined = await checkForceSub(userId);
    if (Array.isArray(notJoined) && notJoined.length > 0) {
        let inlineKeyboard = notJoined.map(ch => [{ text: `Join ${ch.name}`, url: ch.url }]);
        const verifyUrl = `https://your-domain.com/verify.html?userId=${userId}`; // Replace your-domain.com
        inlineKeyboard.push([{ text: "Verify Now ✅", web_app: { url: verifyUrl } }]);
        return bot.sendMessage(chatId, `⚠️ You seem to have left our channel(s)! Please re-join and verify your membership to continue using the bot.`, {
            reply_markup: { inline_keyboard: inlineKeyboard }
        });
    }


    // User State Management for Conversational Flows
    if (userStates[userId] && userStates[userId].step) {
        return handleTaskCreation(msg); // Assuming handleTaskCreation handles different steps
    }

    // Main Menu Logic
    if (text === 'Balance 💰') {
        const userData = await getUserData(userId);
        if (!userData) return bot.sendMessage(chatId, "Error fetching your data. Please try again.");

        const dollarBal = (userData.balanceUsd || 0).toFixed(6); // Assuming balanceUsd for $
        const buxBal = (userData.tasksCompleted || 0).toFixed(2); // Assuming tasksCompleted for Bux
        const balanceMsg = `💸 Your current balance is: <b>${dollarBal}$</b>\n💰 Your Bux rewards are: <b>${buxBal} Bux</b>`;
        bot.sendMessage(chatId, balanceMsg, { parse_mode: 'HTML' });
    }
    else if (text === 'Refer 👥') {
        const userData = await getUserData(userId);
        if (!userData) return bot.sendMessage(chatId, "Error fetching your data. Please try again.");

        const refCode = userData.referralCode || "N/A";
        const totalRefer = userData.referralsCount || 0;

        const botInfo = await bot.getMe();
        const botUsername = botInfo.username;
        const referLink = `https://t.me/${botUsername}?start=${refCode}`;

        const referMsg = `👥 <b>Your Referral System</b>\n\n` +
                         `✅ <b>Active Referrals:</b> ${userData.activeReferrals || 0} (Example, you need to implement this logic)\n` + // Placeholder for Active Referrals
                         `📈 <b>Total Referrals:</b> ${totalRefer}\n\n` +
                         `🔗 <b>Your Link:</b> <code>${referLink}</code>\n\n` +
                         `Share your link with friends to earn more!`;

        bot.sendMessage(chatId, referMsg, {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [
                    [createCopyButton('🔗 Copy Link', referLink)], // Using the new copy button function
                    [{ text: '📈 My Referrers', callback_data: 'my_referrers' }],
                    [{ text: '👥 Share Link', url: `https://t.me/share/url?url=${encodeURIComponent(referLink)}&text=${encodeURIComponent(`Earn with GBuxBot! Use my link: ${referLink}`)}` }]
                ]
            }
        });
    }
    else if (text === 'Ads 📊') {
        bot.sendMessage(chatId, "👇 Choose an ad type to create tasks:", earningMenu);
    }
    else if (text === 'Payout 💸 / Deposit 💰') {
        const userData = await getUserData(userId);
        if (!userData) return bot.sendMessage(chatId, "Error fetching your data. Please try again.");

        const balanceUsd = (userData.balanceUsd || 0).toFixed(6);

        let payoutOptions = [];
        const settingsRef = db.collection('settings').doc('payout');
        const payoutSettings = await settingsRef.get();
        if (payoutSettings.exists && payoutSettings.data().enabled) {
            const minWithdraw = payoutSettings.data().minWithdraw || 0.5;
            if (parseFloat(balanceUsd) >= minWithdraw) {
                payoutOptions.push({ text: '💸 Payout', callback_data: 'request_payout' });
            } else {
                payoutOptions.push({ text: `💸 Payout (Min ${minWithdraw}$ needed)`, callback_data: 'disabled_payout' });
            }
        } else {
             payoutOptions.push({ text: '💸 Payout (Disabled)', callback_data: 'disabled_payout' });
        }

        let depositOptions = [];
        const depositSettingsRef = db.collection('settings').doc('deposit');
        const depositSettings = await depositSettingsRef.get();
        if (depositSettings.exists && depositSettings.data().enabled) {
             depositOptions.push({ text: '💰 Deposit', callback_data: 'request_deposit' });
        } else {
             depositOptions.push({ text: '💰 Deposit (Disabled)', callback_data: 'disabled_deposit' });
        }

        const keyboardRows = [];
        if (payoutOptions.length > 0) keyboardRows.push(payoutOptions);
        if (depositOptions.length > 0) keyboardRows.push(depositOptions);
        keyboardRows.push([{ text: '🔙 Back', callback_data: 'back_to_main_menu' }]);


        bot.sendMessage(chatId, "Choose an option:", {
            reply_markup: {
                inline_keyboard: keyboardRows
            }
        });
    }
    else if (text === 'Rules 📚') {
        bot.sendMessage(chatId, "📚 <b>Bot Rules:</b>\n\n" +
                        "1.  **No Multi-Accounts:** Using multiple accounts to abuse the system is strictly forbidden and will result in a permanent ban.\n" +
                        "2.  **Honest Task Completion:** Complete tasks as instructed. Fake completions or exploitation will be detected.\n" +
                        "3.  **Channel Membership:** You must remain a member of all required channels. Leaving will disable your bot access.\n" +
                        "4.  **Fair Play:** Respect the bot and other users. Any form of harassment or spam will not be tolerated.\n\n" +
                        "Failure to comply with these rules may lead to suspension or permanent ban from the bot.", { parse_mode: 'HTML' });
    }

    // Earning & Ads Menu Logic
    else if (text === '📢 Join Chat Ads') {
        startJoinChatAdCreation(msg);
    }
    else if (text === '🤖 Message Bot Ads') {
        startMessageBotAdCreation(msg);
    }
    else if (text === '👨‍💻 Micro Task Ads') {
        bot.sendMessage(chatId, "👨‍💻 **Micro Task Ads**\n\nComing Soon! We are working on integrating exciting micro-task opportunities for you to earn more.");
        // If Daily Claim WebApp needs to be directly accessible from here:
        // bot.sendMessage(chatId, "👇 Click below to claim your daily rewards!", {
        //     reply_markup: {
        //         inline_keyboard: [
        //             [{ text: "🎁 Daily Claim", web_app: { url: "https://your-domain.com/claim.html" } }] // Replace your-domain.com
        //         ]
        //     }
        // });
    }
    else if (text === '📨 Brodcast Ads') {
        bot.sendMessage(chatId, "📨 **Broadcast Ads**\n\nBroadcast ads feature is under development.");
    }
    else if (text === '🔙 Back') {
        // Clear user state if they are in a conversational flow
        if (userStates[userId]) {
            delete userStates[userId];
        }
        bot.sendMessage(chatId, "🏠 Returning to Main Menu...", mainMenu);
    }
});

// =================================================================
// 8. Ads Task Creation Handlers
// =================================================================

// --- JOIN CHAT ADS ---
async function startJoinChatAdCreation(msg) {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();

    const userData = await getUserData(userId);
    if (!userData) return bot.sendMessage(chatId, "Error fetching your data.");

    const MIN_TASK_AMOUNT = 0.00005; // Minimum amount per task completion
    const MIN_USERS_FOR_TASK = 25; // Minimum users required for task creation

    userStates[userId] = { step: 'awaiting_channel_link_or_username', taskType: 'join_chat' };
    bot.sendMessage(chatId, "📢 **Create Join Chat Ads**\n\nPlease provide the Telegram Channel link or username (e.g., `@mychannel` or `https://t.me/mychannel`).", {
        reply_markup: { force_reply: true }
    });
}

async function handleJoinChatAdCreation(msg) {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    const text = msg.text.trim();
    const state = userStates[userId];

    if (!state || state.taskType !== 'join_chat') return;

    try {
        if (state.step === 'awaiting_channel_link_or_username') {
            let channelUsername = text.replace(/@/g, '').trim();
            if (channelUsername.startsWith('http')) {
                const url = new URL(channelUsername);
                channelUsername = url.pathname.replace(/^\//, '').trim();
            }
            if (!channelUsername) {
                return bot.sendMessage(chatId, "❌ Invalid channel link or username. Please try again.");
            }

            // Check if bot is admin in the channel
            let isBotAdmin = false;
            try {
                const chatMember = await bot.getChatMember(`@${channelUsername}`, 'me'); // 'me' refers to the bot itself
                if (chatMember.status === 'administrator' || chatMember.status === 'creator') {
                    isBotAdmin = true;
                }
            } catch (error) {
                // Bot is likely not admin or channel doesn't exist, or bot is not a member
                console.error(`Bot admin check error for @${channelUsername}:`, error.message);
            }

            if (!isBotAdmin) {
                state.channelUsername = channelUsername; // Store username for later
                state.step = 'awaiting_admin_permission_and_users';
                bot.sendMessage(chatId, `⚠️ The bot is not an administrator of the channel @${channelUsername}.\n\nPlease add the bot as an administrator. After that, enter how many users you want to assign this task to (minimum ${MIN_USERS_FOR_TASK}).`, {
                    reply_markup: { force_reply: true }
                });
            } else {
                state.channelUsername = channelUsername;
                state.step = 'awaiting_users_count';
                bot.sendMessage(chatId, `✅ Bot is an administrator of @${channelUsername}.\n\nEnter how many users you want to assign this task to (minimum ${MIN_USERS_FOR_TASK}).`, {
                    reply_markup: { force_reply: true }
                });
            }

        } else if (state.step === 'awaiting_admin_permission_and_users') {
            const usersCount = parseInt(text, 10);
            const MIN_USERS_FOR_TASK = 25; // Defined earlier
            if (isNaN(usersCount) || usersCount < MIN_USERS_FOR_TASK) {
                return bot.sendMessage(chatId, `❌ Please enter a valid number of users, minimum ${MIN_USERS_FOR_TASK}.`);
            }

            state.usersNeeded = usersCount;
            state.step = 'awaiting_task_reward';
            bot.sendMessage(chatId, `✅ You have set the task for ${usersCount} users.\n\nNow, enter the reward amount for each completed task (minimum $${MIN_TASK_AMOUNT.toFixed(5)}).`, {
                reply_markup: { force_reply: true }
            });

        } else if (state.step === 'awaiting_users_count') { // When bot is already admin
            const usersCount = parseInt(text, 10);
            const MIN_USERS_FOR_TASK = 25;
            if (isNaN(usersCount) || usersCount < MIN_USERS_FOR_TASK) {
                return bot.sendMessage(chatId, `❌ Please enter a valid number of users, minimum ${MIN_USERS_FOR_TASK}.`);
            }

            state.usersNeeded = usersCount;
            state.step = 'awaiting_task_reward';
            bot.sendMessage(chatId, `✅ You have set the task for ${usersCount} users.\n\nNow, enter the reward amount for each completed task (minimum $${MIN_TASK_AMOUNT.toFixed(5)}).`, {
                reply_markup: { force_reply: true }
            });

        } else if (state.step === 'awaiting_task_reward') {
            const rewardPerUser = parseFloat(text);
            const MIN_TASK_AMOUNT = 0.00005;
            if (isNaN(rewardPerUser) || rewardPerUser < MIN_TASK_AMOUNT) {
                return bot.sendMessage(chatId, `❌ Invalid amount. Minimum reward per task is $${MIN_TASK_AMOUNT.toFixed(5)}.`);
            }

            state.rewardPerUser = rewardPerUser;
            state.totalCost = state.usersNeeded * rewardPerUser; // This is the cost for the user to create the task

            const userData = await getUserData(userId);
            if (!userData || userData.balanceUsd < state.totalCost) {
                delete userStates[userId];
                return bot.sendMessage(chatId, `❌ Insufficient balance. You need $${state.totalCost.toFixed(6)} for this task, but your balance is $${(userData?.balanceUsd || 0).toFixed(6)}. Task creation cancelled.`);
            }

            const confirmationMsg = `📢 **Confirm Join Chat Task Creation:**\n\n` +
                                  `**Channel:** @${state.channelUsername}\n` +
                                  `**Task Type:** Join Chat\n` +
                                  `**Number of Users:** ${state.usersNeeded}\n` +
                                  `**Reward per Task:** $${state.rewardPerUser.toFixed(6)}\n` +
                                  `**Total Cost to Create:** $${state.totalCost.toFixed(6)}\n\n` +
                                  `Type **yes** to confirm or **no** to cancel.`;
            state.step = 'awaiting_confirmation';
            bot.sendMessage(chatId, confirmationMsg, { parse_mode: 'Markdown' });
        } else if (state.step === 'awaiting_confirmation') {
            if (text.toLowerCase() === 'yes') {
                // Deduct cost and create task
                const userRef = db.collection('users').doc(userId);
                await userRef.update({
                    balanceUsd: FieldValue.increment(-state.totalCost),
                    tasksCreated: FieldValue.increment(1) // Increment task created count
                });

                const taskId = uuidv4();
                await db.collection('tasks').doc(taskId).set({
                    taskId,
                    creatorId: userId,
                    taskType: 'join_chat',
                    channelUsername: state.channelUsername,
                    rewardPerUser: state.rewardPerUser,
                    usersNeeded: state.usersNeeded,
                    usersCompleted: 0,
                    completedBy: [],
                    status: 'active',
                    createdAt: new Date()
                });

                bot.sendMessage(chatId, "✅ Your Join Chat task has been created successfully!", adsMenu);
                delete userStates[userId];
            } else {
                bot.sendMessage(chatId, "❌ Task creation cancelled.", adsMenu);
                delete userStates[userId];
            }
        }
    } catch (error) {
        console.error("Error in handleJoinChatAdCreation:", error);
        bot.sendMessage(chatId, "An error occurred during task creation. Please try again.", adsMenu);
        delete userStates[userId];
    }
}

// --- MESSAGE BOT ADS ---
async function startMessageBotAdCreation(msg) {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    const MIN_TASK_AMOUNT = 0.00005;
    const MIN_USERS_FOR_TASK = 25; // Same minimum users as Join Chat Ads

    userStates[userId] = { step: 'awaiting_bot_username', taskType: 'message_bot' };
    bot.sendMessage(chatId, "🤖 **Create Message Bot Ads**\n\nPlease enter the username of the bot you want users to message (e.g., `MyAwesomeBot`). Do not include the '@' symbol.", {
        reply_markup: { force_reply: true }
    });
}

async function handleMessageBotAdCreation(msg) {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    const text = msg.text.trim();
    const state = userStates[userId];

    if (!state || state.taskType !== 'message_bot') return;

    try {
        if (state.step === 'awaiting_bot_username') {
            state.botUsername = text.replace(/@/g, ''); // Remove @ if user adds it
            state.step = 'awaiting_users_count';
            bot.sendMessage(chatId, `✅ Bot username set to: <b>@${state.botUsername}</b>\n\nNow, enter how many users you want for this task (minimum ${MIN_USERS_FOR_TASK}).`, {
                parse_mode: 'HTML',
                reply_markup: { force_reply: true }
            });
        } else if (state.step === 'awaiting_users_count') {
            const usersCount = parseInt(text, 10);
            const MIN_USERS_FOR_TASK = 25;
            if (isNaN(usersCount) || usersCount < MIN_USERS_FOR_TASK) {
                return bot.sendMessage(chatId, `❌ Please enter a valid number of users, minimum ${MIN_USERS_FOR_TASK}.`);
            }

            state.usersNeeded = usersCount;
            state.step = 'awaiting_task_reward';
            bot.sendMessage(chatId, `✅ You have set the task for ${usersCount} users.\n\nNow, enter the reward amount for each completed task (minimum $${MIN_TASK_AMOUNT.toFixed(5)}).`, {
                reply_markup: { force_reply: true }
            });
        } else if (state.step === 'awaiting_task_reward') {
            const rewardPerUser = parseFloat(text);
            const MIN_TASK_AMOUNT = 0.00005;
            if (isNaN(rewardPerUser) || rewardPerUser < MIN_TASK_AMOUNT) {
                return bot.sendMessage(chatId, `❌ Invalid amount. Minimum reward per task is $${MIN_TASK_AMOUNT.toFixed(5)}.`);
            }

            state.rewardPerUser = rewardPerUser;
            state.totalCost = state.usersNeeded * rewardPerUser;

            const userData = await getUserData(userId);
            if (!userData || userData.balanceUsd < state.totalCost) {
                delete userStates[userId];
                return bot.sendMessage(chatId, `❌ Insufficient balance. You need $${state.totalCost.toFixed(6)} for this task, but your balance is $${(userData?.balanceUsd || 0).toFixed(6)}. Task creation cancelled.`);
            }

            const confirmationMsg = `🤖 **Confirm Message Bot Task Creation:**\n\n` +
                                  `**Bot Username:** @${state.botUsername}\n` +
                                  `**Task Type:** Message Bot\n` +
                                  `**Number of Users:** ${state.usersNeeded}\n` +
                                  `**Reward per Task:** $${state.rewardPerUser.toFixed(6)}\n` +
                                  `**Total Cost to Create:** $${state.totalCost.toFixed(6)}\n\n` +
                                  `Type **yes** to confirm or **no** to cancel.`;
            state.step = 'awaiting_confirmation';
            bot.sendMessage(chatId, confirmationMsg, { parse_mode: 'Markdown' });
        } else if (state.step === 'awaiting_confirmation') {
            if (text.toLowerCase() === 'yes') {
                const userRef = db.collection('users').doc(userId);
                await userRef.update({
                    balanceUsd: FieldValue.increment(-state.totalCost),
                    tasksCreated: FieldValue.increment(1)
                });

                const taskId = uuidv4();
                await db.collection('tasks').doc(taskId).set({
                    taskId,
                    creatorId: userId,
                    taskType: 'message_bot',
                    botUsername: state.botUsername,
                    rewardPerUser: state.rewardPerUser,
                    usersNeeded: state.usersNeeded,
                    usersCompleted: 0,
                    completedBy: [],
                    status: 'active',
                    createdAt: new Date()
                });

                bot.sendMessage(chatId, "✅ Your Message Bot task has been created successfully!", adsMenu);
                delete userStates[userId];
            } else {
                bot.sendMessage(chatId, "❌ Task creation cancelled.", adsMenu);
                delete userStates[userId];
            }
        }
    } catch (error) {
        console.error("Error in handleMessageBotAdCreation:", error);
        bot.sendMessage(chatId, "An error occurred during task creation. Please try again.", adsMenu);
        delete userStates[userId];
    }
}

// --- Micro Task Ads & Broadcast Ads ---
// (These are currently placeholders)
// The '👨‍💻 Micro Task Ads' will display "Coming Soon" and potentially a link to a WebApp.
// The '📨 Brodcast Ads' is also a placeholder.

// Function to handle the task creation flow (used by both Join Chat and Message Bot)
async function handleTaskCreation(msg) {
    const userId = msg.from.id.toString();
    const state = userStates[userId];

    if (!state) return;

    if (state.taskType === 'join_chat') {
        await handleJoinChatAdCreation(msg);
    } else if (state.taskType === 'message_bot') {
        await handleMessageBotAdCreation(msg);
    }
    // Add other task types here if needed
}


// =================================================================
// 9. Callback Query, Verification & Admin API
// =================================================================
bot.on('callback_query', async (query) => {
    const userId = query.from.id.toString();
    const chatId = query.message.chat.id;
    const data = query.data;

    // --- Payout/Deposit Callbacks ---
    if (data === 'request_payout') {
        const userData = await getUserData(userId);
        if (!userData) return bot.sendMessage(chatId, "Error fetching your data.");

        const minWithdrawalRef = db.collection('settings').doc('payout');
        const minWithdrawalSnapshot = await minWithdrawalRef.get();
        const minWithdraw = minWithdrawalSnapshot.exists ? (minWithdrawalSnapshot.data().minWithdraw || 0.5) : 0.5;

        if ((userData.balanceUsd || 0) < minWithdraw) {
            return bot.sendMessage(chatId, `You need at least $${minWithdraw.toFixed(2)} to request a payout.`);
        }

        userStates[userId] = { step: 'awaiting_usdt_address', action: 'payout' };
        bot.sendMessage(chatId, "Please enter your USDT (BEP-20) address to receive your payout.", {
            reply_markup: { force_reply: true }
        });
    } else if (data === 'request_deposit') {
        // Logic for requesting deposit
        // You would typically show the user a deposit address and instructions
        bot.sendMessage(chatId, "Deposits are processed manually. Please contact admin for deposit details.");
        // You might want to create a pending deposit entry in the database and notify admin
    } else if (data === 'disabled_payout' || data === 'disabled_deposit') {
        bot.answerCallbackQuery(query.id, { text: "This feature is currently disabled.", show_alert: true });
    } else if (data === 'back_to_main_menu') {
        bot.sendMessage(chatId, "🏠 Returning to Main Menu...", mainMenu);
        bot.answerCallbackQuery(query.id);
    }

    // --- Referral System Callback ---
    else if (data === 'my_referrers') {
        try {
            const userData = await getUserData(userId);
            if (!userData) return bot.sendMessage(chatId, "Error fetching your data.");

            const refCode = userData.referralCode;
            if (!refCode) return bot.sendMessage(chatId, "You do not have a referral code.");

            const refsSnapshot = await db.collection('users').where('referredBy', '==', refCode).get();

            if (refsSnapshot.empty) {
                bot.answerCallbackQuery(query.id, { text: "You haven't referred anyone yet!", show_alert: true });
                return;
            }

            let msgText = `📈 <b>Your Referrers List:</b>\n\n`;
            let count = 1;
            refsSnapshot.forEach(doc => {
                const u = doc.data();
                msgText += `${count}. ${u.firstName} (ID: <code>${u.userId}</code>) - Joined: ${u.joinedAt ? u.joinedAt.toDate().toLocaleDateString() : 'N/A'}\n`;
                count++;
            });

            bot.sendMessage(chatId, msgText, { parse_mode: 'HTML' });
            bot.answerCallbackQuery(query.id);

        } catch (error) {
            console.error(error);
            bot.answerCallbackQuery(query.id, { text: "Error loading referrers.", show_alert: true });
        }
    }
    // Add other callback data handlers here if needed
});

// --- Handle user input for Payout/Deposit ---
async function handlePayoutDepositInput(msg) {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    const text = msg.text.trim();
    const state = userStates[userId];

    if (!state || !state.action) return;

    if (state.action === 'payout') {
        if (state.step === 'awaiting_usdt_address') {
            // Validate USDT BEP-20 address (basic check)
            const usdtAddressRegex = /^0x[a-fA-F0-9]{40}$/;
            if (!usdtAddressRegex.test(text)) {
                return bot.sendMessage(chatId, "❌ Invalid USDT (BEP-20) address. Please enter a valid address starting with '0x' and followed by 40 hexadecimal characters.");
            }

            // Store address and proceed to confirmation or send to admin
            const userData = await getUserData(userId);
            if (!userData) return bot.sendMessage(chatId, "Error fetching your data.");

            const minWithdraw = (await db.collection('settings').doc('payout').get()).data()?.minWithdraw || 0.5;
            const currentBalance = userData.balanceUsd || 0;

            // Create payout request
            const payoutId = uuidv4();
            await db.collection('payoutRequests').doc(payoutId).set({
                payoutId,
                userId,
                userName: userData.firstName,
                usdtAddress: text,
                amount: currentBalance, // Requesting full available balance for simplicity, adjust if needed
                status: 'pending',
                requestedAt: new Date(),
                processedAt: null,
                adminNotes: null
            });

            // Notify Admin
            const adminChatId = process.env.ADMIN_CHAT_ID || '7767338426'; // Ensure this is set in your .env
            try {
                await bot.sendMessage(adminChatId,
                    `💸 New Payout Request:\n` +
                    `User: ${userData.firstName} (ID: ${userId})\n` +
                    `Amount: $${currentBalance.toFixed(6)}\n` +
                    `USDT (BEP-20) Address: <code>${text}</code>\n` +
                    `Request ID: ${payoutId}\n\n` +
                    `Use /approve_payout ${payoutId} or /cancel_payout ${payoutId} command.`
                    , { parse_mode: 'HTML' });
            } catch (error) {
                console.error(`Error sending payout request notification to admin (${adminChatId}):`, error.message);
            }

            // Update user's balance (set to 0 or deduct amount if admin approval is not strictly needed for this step)
            // For simplicity, we'll set it to 0 and let admin handle the actual transfer.
            await db.collection('users').doc(userId).update({
                balanceUsd: 0
            });


            bot.sendMessage(chatId, `✅ Your payout request for $${currentBalance.toFixed(6)} has been submitted to the admin for review. Please wait for their approval. You will be notified once it's processed.`);
            delete userStates[userId]; // Clear state after successful request
        }
    }
    // Add more payout/deposit handling steps if needed
}

// Handle messages that might be inputs for payout/deposit
bot.on('message', async (msg) => {
    // ... existing message handlers ...

    // If user is in a Payout/Deposit conversational flow
    if (userStates[msg.from.id.toString()] && userStates[msg.from.id.toString()].action) {
        await handlePayoutDepositInput(msg);
        return; // Prevent further processing of this message in the main handlers
    }

    // ... rest of your message handlers ...
});


// --- Verification ---
app.post('/api/verify-channel', async (req, res) => {
    const { userId } = req.body;
    if (!userId) {
        return res.status(400).json({ success: false, message: "User ID is missing!" });
    }

    const notJoined = await checkForceSub(userId);

    if (!notJoined || (Array.isArray(notJoined) && notJoined.length === 0)) {
        const userRef = db.collection('users').doc(userId);
        const userDoc = await userRef.get();
        const userData = userDoc.data();

        // Referral Bonus for Verification
        if (userData && userData.referredBy) {
            const referrerQuery = await db.collection('users').where('referralCode', '==', userData.referredBy).limit(1).get();
            if (!referrerQuery.empty) {
                const referrerDoc = referrerQuery.docs[0];
                const referrerId = referrerDoc.id;
                // Check if this referral bonus has already been paid to prevent duplicates
                const referrerUserData = referrerDoc.data();
                if (referrerUserData.referralBonusPaid !== true) { // Assuming referralBonusPaid is a boolean field
                    await db.collection('users').doc(referrerId).update({
                        balanceUsd: FieldValue.increment(0.002), // Bonus for referrer
                        referralBonusPaid: true // Mark as paid for referrer
                    });
                     await bot.sendMessage(referrerId, `✅ Your referred user, ${userData.firstName}, has successfully verified their channels. You have received a bonus of $0.002!`);
                }
            }
             // Mark the user as having received the bonus if needed, or ensure they don't get it again.
             // If you want the user who verified to get something, add it here.
        }


        bot.sendMessage(userId, "✅ Verification Successful! You can now use all the features of the bot.", mainMenu);
        return res.json({ success: true, message: "Verification successful!" });
    } else {
        return res.json({ success: false, message: "You haven't joined all required channels!" });
    }
});

// --- Admin Commands (Example) ---
// Add these commands to your bot logic if you want to manage payouts via bot
bot.onText(/\/approve_payout (\w+)/, async (msg, match) => {
    const adminChatId = process.env.ADMIN_CHAT_ID || '7767338426';
    if (msg.chat.id.toString() !== adminChatId) return; // Only admin can use this

    const payoutId = match[1];
    try {
        const payoutRef = db.collection('payoutRequests').doc(payoutId);
        const payoutDoc = await payoutRef.get();

        if (!payoutDoc.exists) {
            return bot.sendMessage(msg.chat.id, `Payout request with ID ${payoutId} not found.`);
        }

        const payoutData = payoutDoc.data();
        if (payoutData.status !== 'pending') {
            return bot.sendMessage(msg.chat.id, `Payout request ${payoutId} is already ${payoutData.status}.`);
        }

        // Perform actual transfer or mark as processed
        await payoutRef.update({
            status: 'approved',
            processedAt: new Date()
        });

        // Notify user
        try {
            await bot.sendMessage(payoutData.userId, `✅ Your payout request of $${payoutData.amount.toFixed(6)} has been approved and processed.`);
        } catch (error) {
            console.error(`Error notifying user ${payoutData.userId} about payout approval:`, error.message);
        }

        bot.sendMessage(msg.chat.id, `Payout request ${payoutId} approved and user notified.`);
    } catch (error) {
        console.error(`Error approving payout ${payoutId}:`, error);
        bot.sendMessage(msg.chat.id, `Error approving payout request ${payoutId}.`);
    }
});

bot.onText(/\/cancel_payout (\w+)/, async (msg, match) => {
    const adminChatId = process.env.ADMIN_CHAT_ID || '7767338426';
    if (msg.chat.id.toString() !== adminChatId) return;

    const payoutId = match[1];
    try {
        const payoutRef = db.collection('payoutRequests').doc(payoutId);
        const payoutDoc = await payoutRef.get();

        if (!payoutDoc.exists) {
            return bot.sendMessage(msg.chat.id, `Payout request with ID ${payoutId} not found.`);
        }

        const payoutData = payoutDoc.data();
        if (payoutData.status !== 'pending') {
            return bot.sendMessage(msg.chat.id, `Payout request ${payoutId} is already ${payoutData.status}.`);
        }

        // Revert balance and mark as cancelled
        await payoutRef.update({
            status: 'cancelled',
            processedAt: new Date(),
            adminNotes: 'Cancelled by Admin'
        });

        // Restore user balance
        await db.collection('users').doc(payoutData.userId).update({
            balanceUsd: FieldValue.increment(payoutData.amount)
        });

        // Notify user
        try {
            await bot.sendMessage(payoutData.userId, `❌ Your payout request of $${payoutData.amount.toFixed(6)} has been cancelled by the admin.`);
        } catch (error) {
            console.error(`Error notifying user ${payoutData.userId} about payout cancellation:`, error.message);
        }

        bot.sendMessage(msg.chat.id, `Payout request ${payoutId} cancelled and user notified. Balance restored.`);
    } catch (error) {
        console.error(`Error cancelling payout ${payoutId}:`, error);
        bot.sendMessage(msg.chat.id, `Error cancelling payout request ${payoutId}.`);
    }
});


// =================================================================
// 10. Start Server
// =================================================================
app.listen(PORT, () => {
    console.log(`✅ Server is running and listening on port ${PORT}`);
});

// --- Helper for WebApp Verification ---
// This will be served by express
app.get('/verify.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'verify.html'));
});

// --- Dummy Admin HTML file for now ---
// You would need to build a proper admin panel and serve it here.
app.get('/admin.html', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Admin Panel</title>
        </head>
        <body>
            <h1>Admin Panel</h1>
            <p>This is a placeholder for your admin panel. You would implement functionalities here to control Withdrawals, Deposits, view users, etc.</p>
            <p>Example: <a href="https://your-domain.com/admin/withdrawals">Manage Withdrawals</a></p>
            <p>Example: <a href="https://your-domain.com/admin/deposits">Manage Deposits</a></p>
        </body>
        </html>
    `);
});

// --- Daily Claim WebApp HTML ---
// You'll need to create this file and host it.
app.get('/claim.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'claim.html'));
});

// Add these at the end of your file for handling inline bot messages
// Example: bot.on('inline_query', ...);
