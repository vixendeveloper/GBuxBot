const TelegramBot = require('node-telegram-bot-api');
const admin = require('firebase-admin');
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');

// --- Firebase Initialization ---
let serviceAccount;
try {
    serviceAccount = JSON.parse(process.env.FIREBASE_ADMIN_SDK_KEY);
} catch (e) {
    console.error("Failed to parse FIREBASE_ADMIN_SDK_KEY. Ensure it's a valid JSON string.", e);
    process.exit(1);
}

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// --- Data Storage References ---
const channelsRef = db.collection('botSettings').doc('channels');
const sourceCodesRef = db.collection('sourceCodes');
const settingsRef = db.collection('botSettings').doc('settings');

// --- Telegram Bot Setup ---
const token = process.env.BOT_TOKEN;
const botUsername = process.env.BOT_USERNAME;
const adminUserId = parseInt(process.env.ADMIN_USER_ID);

if (!token) {
    console.error("TELEGRAM_BOT_TOKEN is not set.");
    process.exit(1);
}
if (!botUsername) {
    console.error("BOT_USERNAME is not set.");
    process.exit(1);
}
if (isNaN(adminUserId)) {
    console.error("ADMIN_USER_ID is not set or invalid.");
    process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

// --- Express Setup ---
const app = express();
const port = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.urlencoded({ extended: true }));

// --- State Management for Admin Actions ---
// Stores intermediate data for multi-step admin actions
const adminState = {};

// --- Helper Functions ---

async function getUser(userId) {
    const userDoc = await db.collection('users').doc(String(userId)).get();
    if (userDoc.exists) {
        return userDoc.data();
    }
    const newUser = {
        balance: 0,
        referredCount: 0,
        referredBy: null,
        joinedChannels: {}
    };
    await db.collection('users').doc(String(userId)).set(newUser);
    return newUser;
}

async function updateUser(userId, data) {
    await db.collection('users').doc(String(userId)).set(data, { merge: true });
}

async function getChannels() {
    const doc = await channelsRef.get();
    if (doc.exists && doc.data().list) return doc.data().list;
    return [];
}

async function addChannel(channelUsername, channelLink) {
    const currentChannels = await getChannels();
    // Check if username already exists
    const existingChannel = currentChannels.find(c => c.username === channelUsername);
    if (existingChannel) return false; // Already exists

    await channelsRef.set({ list: [...currentChannels, { username: channelUsername, link: channelLink }] });
    return true;
}

async function removeChannel(channelUsername) {
    const currentChannels = await getChannels();
    const updatedChannels = currentChannels.filter(c => c.username !== channelUsername);
    if (currentChannels.length > updatedChannels.length) {
        await channelsRef.set({ list: updatedChannels });
        return true;
    }
    return false;
}

async function getSourceCodes() {
    const snapshot = await sourceCodesRef.get();
    const sourceCodes = [];
    snapshot.forEach(doc => { sourceCodes.push({ id: doc.id, ...doc.data() }); });
    // Sort by ID numerically
    return sourceCodes.sort((a, b) => parseInt(a.id) - parseInt(b.id));
}

async function addSourceCode(data) {
    // Use a more robust ID generation if Date.now() can collide
    const newId = Date.now().toString();
    await sourceCodesRef.doc(newId).set({ ...data, id: newId });
    return newId;
}

async function removeSourceCode(sourceCodeId) {
    await sourceCodesRef.doc(sourceCodeId).delete();
}

async function getSettings() {
    const doc = await settingsRef.get();
    if (doc.exists && doc.data().referralCoinReward !== undefined) return doc.data();
    return { referralCoinReward: 10 };
}

async function setReferralCoinReward(reward) {
    await settingsRef.set({ referralCoinReward: reward });
}

async function checkChannelMembership(userId, channel) {
    try {
        // 'channel' here is the object { username: '@...', link: '...' }
        const chatMember = await bot.getChatMember(channel.username, userId);
        return ['member', 'administrator', 'creator'].includes(chatMember.status);
    } catch (error) {
        console.error(`Error checking membership for user ${userId} in ${channel.username}:`, error.message);
        return false;
    }
}

function getReferralLink(userId) {
    return `https://t.me/${botUsername}?start=${userId}`;
}

// --- Bot Commands ---

bot.onText(/\/start(?: (\d+))?/, async (msg, match) => {
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    const referrerId = match[1] ? parseInt(match[1]) : null;

    let user = await getUser(userId);

    if (referrerId && referrerId !== userId) {
        const referrer = await getUser(referrerId);
        const settings = await getSettings();
        const reward = settings.referralCoinReward || 10;

        if (referrer) {
            referrer.referredCount++;
            user.referredBy = referrerId;
            referrer.balance += reward;
            await updateUser(referrerId, { balance: referrer.balance, referredCount: referrer.referredCount });
            bot.sendMessage(referrerId, `🥳 You just earned ${reward} SpyCoin for a new referral! Your balance is now ${referrer.balance}.`);
        }
        await updateUser(userId, { referredBy: referrerId });
    }

    const channels = await getChannels();
    let channelsToJoin = [];
    const userJoinedChannels = user.joinedChannels || {};

    for (const channel of channels) {
        const isJoined = await checkChannelMembership(userId, channel);
        userJoinedChannels[channel.username] = isJoined; // Use username as key
        if (!isJoined) channelsToJoin.push(channel);
    }

    user.joinedChannels = userJoinedChannels;
    await updateUser(userId, { joinedChannels: user.joinedChannels });

    if (channelsToJoin.length > 0) {
        let message = "Please join the following channels first to access the bot:\n\n";
        channelsToJoin.forEach(channel => { message += `- [${channel.username}](${channel.link})\n`; });
        message += "\nAfter joining, please send `/start` again.";
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } else {
        showMainMenu(chatId, userId);
    }
});

// --- Main Menu Handler ---
async function showMainMenu(chatId, userId) {
    const keyboard = [
        [{ text: '✨ Source Codes' }],
        [{ text: '💰 Balance' }, { text: '🔗 Refer' }]
    ];
    bot.sendMessage(chatId, '🌟 *Welcome to the Main Menu!*', { // Bolded welcome message
        parse_mode: 'Markdown',
        reply_markup: {
            keyboard: keyboard,
            one_time_keyboard: true, // This will remove the keyboard after the user selects an option
            resize_keyboard: true
        }
    });

    const adsMessage = "*Ads* - [খুচরো ডলার বিক্রি করুন](https://t.me/RedExChangerBot/app)";
    bot.sendMessage(chatId, adsMessage, { parse_mode: 'Markdown' });
}

// --- Callback Query Handler ---
bot.on('callback_query', async (callbackQuery) => {
    const message = callbackQuery.message;
    const userId = callbackQuery.from.id;
    const chatId = message.chat.id;
    const data = callbackQuery.data;

    bot.answerCallbackQuery(callbackQuery.id);

    if (data === 'source_codes') {
        showSourceCodesMenu(chatId, userId);
    } else if (data === 'balance') {
        showBalance(chatId, userId);
    } else if (data === 'refer') {
        showReferralInfo(chatId, userId);
    } else if (data.startsWith('view_source_code_')) {
        const sourceCodeId = data.split('_')[3];
        await viewSourceCode(chatId, userId, sourceCodeId);
    } else if (data.startsWith('unlock_source_code_')) {
        const sourceCodeId = data.split('_')[3];
        await unlockSourceCode(chatId, userId, sourceCodeId, message.message_id);
    } else if (data === 'earn') {
        bot.editMessageText("⏳ Coming Soon!", { chat_id: chatId, message_id: message.message_id, reply_markup: { inline_keyboard: [] } });
    } else if (data === 'next_source_code') {
        const currentSourceCodeId = message.text.match(/Source Code ID: (\d+)/)?.[1];
        if (currentSourceCodeId) {
            const allSourceCodes = await getSourceCodes();
            const currentIndex = allSourceCodes.findIndex(sc => sc.id === currentSourceCodeId);
            if (currentIndex !== -1 && currentIndex < allSourceCodes.length - 1) {
                const nextSourceCode = allSourceCodes[currentIndex + 1];
                await bot.deleteMessage(chatId, message.message_id);
                await viewSourceCode(chatId, userId, nextSourceCode.id);
            } else {
                bot.editMessageText("No more source codes available at the moment.", { chat_id: chatId, message_id: message.message_id, reply_markup: { inline_keyboard: [] } });
            }
        }
    } else if (data === 'back_to_source_codes') {
        showSourceCodesMenu(chatId, userId);
    } else if (data === 'main_menu') {
        showMainMenu(chatId, userId);
    }
});

// --- Handling Keyboard Button Presses for Main Menu ---
bot.onText(/💰 Balance/, async (msg) => {
    await showBalance(msg.chat.id, msg.from.id);
});

bot.onText(/🔗 Refer/, async (msg) => {
    await showReferralInfo(msg.chat.id, msg.from.id);
});

bot.onText(/✨ Source Codes/, async (msg) => {
    await showSourceCodesMenu(msg.chat.id, msg.from.id);
});


// --- Menu/Info Display Functions ---

async function showBalance(chatId, userId) {
    const user = await getUser(userId);
    const supportGroupLink = "https://t.me/+rYxM4JzaTDE5MWM1";
    // Removed total refer count from here
    const balanceInfo = `Your current SpyCoin balance is: ${user.balance} SpyCoin 💰\n\n*User Information:*\nChat ID: \`${userId}\``;

    const keyboard = [
        [{ text: 'Join Support Group', url: supportGroupLink }],
        // Removed "Back to Main Menu" inline button from Balance
    ];

    bot.sendMessage(chatId, balanceInfo, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: keyboard
        }
    });
}

async function showReferralInfo(chatId, userId) {
    const user = await getUser(userId);
    const referralLink = getReferralLink(userId);
    const settings = await getSettings();
    const referralReward = settings.referralCoinReward || 10;

    const joinGroupLink = "https://t.me/+7QEDhovtqJ4yZTA1";
    const keyboard = [
        // Removed "Copy Referral Link" option as requested
        [{ text: 'Join Refer Link Share Group', url: joinGroupLink }], // New button
        // Removed "Back to Main Menu" inline button from Refer
    ];

    // Removed total refer count from this message
    bot.sendMessage(chatId, `🔗 Your Referral Link: \n${referralLink}\n\nEarn ${referralReward} SpyCoin for each successful referral!`, {
        reply_markup: {
            inline_keyboard: keyboard
        }
    });
}

async function showSourceCodesMenu(chatId, userId) {
    const sourceCodes = await getSourceCodes();
    if (sourceCodes.length === 0) {
        bot.sendMessage(chatId, "No source codes available yet.");
        return;
    }

    const keyboard = sourceCodes.map(sc => [
        { text: `🔗 ${sc.caption.substring(0, 30)}...`, callback_data: `view_source_code_${sc.id}` }
    ]);
    keyboard.push([{ text: 'Back to Main Menu', callback_data: 'main_menu' }]);

    bot.sendMessage(chatId, 'Here are the available Source Codes:', {
        reply_markup: {
            inline_keyboard: keyboard
        }
    });
}

async function viewSourceCode(chatId, userId, sourceCodeId) {
    const user = await getUser(userId);
    const sourceCodes = await getSourceCodes();
    const sourceCode = sourceCodes.find(sc => sc.id === sourceCodeId);

    if (!sourceCode) {
        bot.sendMessage(chatId, "Source code not found.");
        return;
    }

    const isUnlocked = user.balance >= sourceCode.unlockCost;

    let messageText = `✨ **${sourceCode.caption}** ✨\n\n`;
    if (sourceCode.imageLink) messageText += `[Image Preview](${sourceCode.imageLink})\n\n`;
    messageText += `Unlock Cost: ${sourceCode.unlockCost} SpyCoin 💰\n`;
    messageText += `Source Code ID: ${sourceCode.id}\n`;

    let inlineKeyboard = [];

    if (isUnlocked) {
        inlineKeyboard.push([{ text: 'Open Source Code', url: sourceCode.fileLink }]);
    } else {
        inlineKeyboard.push([{ text: 'Unlock File', callback_data: `unlock_source_code_${sourceCode.id}` }]);
        inlineKeyboard.push([{ text: 'Earn More Coins', callback_data: 'earn' }]);
    }

    const currentIndex = sourceCodes.findIndex(sc => sc.id === sourceCodeId);
    let navButtons = [];
    if (currentIndex > 0) {
        navButtons.push({ text: 'Back', callback_data: `view_source_code_${sourceCodes[currentIndex - 1].id}` });
    }
    if (currentIndex < sourceCodes.length - 1) {
        navButtons.push({ text: 'Next', callback_data: `view_source_code_${sourceCodes[currentIndex + 1].id}` });
    }
    if (navButtons.length > 0) inlineKeyboard.push(navButtons);

    inlineKeyboard.push([{ text: 'Back to Source Codes', callback_data: 'back_to_source_codes' }]);

    bot.sendMessage(chatId, messageText, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
}

async function unlockSourceCode(chatId, userId, sourceCodeId, messageId) {
    let user = await getUser(userId);
    const sourceCodes = await getSourceCodes();
    const sourceCode = sourceCodes.find(sc => sc.id === sourceCodeId);

    if (!sourceCode) {
        bot.sendMessage(chatId, "Source code not found.");
        return;
    }

    if (user.balance >= sourceCode.unlockCost) {
        user.balance -= sourceCode.unlockCost;
        await updateUser(userId, { balance: user.balance });

        await bot.editMessageText(`✨ **${sourceCode.caption}** ✨\n\n${sourceCode.imageLink ? `[Image Preview](${sourceCode.imageLink})\n\n` : ''}Unlocked! Here is your link:\n[Open Source Code](${sourceCode.fileLink})`, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [] }
        });
    } else {
        bot.sendMessage(chatId, `You need ${sourceCode.unlockCost} SpyCoin to unlock this. Your current balance is ${user.balance} SpyCoin.`, {
            reply_markup: {
                inline_keyboard: [
                    [{ text: 'Earn More Coins', callback_data: 'earn' }],
                    [{ text: 'Back', callback_data: `view_source_code_${sourceCodeId}` }]
                ]
            }
        });
    }
}

// --- Admin Panel Access Command ---
bot.onText(/\/admin/, async (msg) => {
    const userId = msg.from.id;
    if (userId !== adminUserId) {
        return bot.sendMessage(msg.chat.id, "You are not authorized to access the admin panel.");
    }
    // Show Admin Menu
    const adminMenuKeyboard = [
        [{ text: 'Manage Source Codes' }],
        [{ text: 'Manage Channels' }],
        [{ text: 'Manage Users' }],
        [{ text: 'Settings' }]
    ];
    bot.sendMessage(msg.chat.id, '🌟 Welcome to the Admin Panel!', {
        reply_markup: {
            keyboard: adminMenuKeyboard,
            one_time_keyboard: true,
            resize_keyboard: true
        }
    });
});

// --- Admin Panel Command Handlers (using keyboard buttons) ---

// Handle 'Manage Source Codes' from Admin Menu
bot.onText(/Manage Source Codes/, async (msg) => {
    const adminMenuKeyboard = [
        [{ text: 'Add New Source Code' }],
        [{ text: 'Remove Source Code' }],
        [{ text: 'Back to Admin Menu' }]
    ];
    bot.sendMessage(msg.chat.id, 'Choose an action for Source Codes:', {
        reply_markup: {
            keyboard: adminMenuKeyboard,
            one_time_keyboard: true,
            resize_keyboard: true
        }
    });
});

// Handle 'Add New Source Code'
bot.onText(/Add New Source Code/, (msg) => {
    adminState[msg.from.id] = { step: 'awaiting_image' };
    bot.sendMessage(msg.chat.id, 'Please send the Image for the source code.');
});

// Handler for images sent during Add New Source Code flow
bot.on('photo', async (msg) => {
    const userId = msg.from.id;
    if (adminState[userId] && adminState[userId].step === 'awaiting_image') {
        const photo = msg.photo[msg.photo.length - 1]; // Get the largest size
        adminState[userId].imageFileId = photo.file_id;
        adminState[userId].step = 'awaiting_caption';
        bot.sendMessage(msg.chat.id, 'Image received. Now, please send the Caption for the source code.');
    }
});

// Handler for text messages during Add New Source Code flow
bot.on('text', async (msg) => {
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    const text = msg.text;

    if (!adminState[userId]) return; // Not in an admin flow

    // --- Handle Add New Source Code Steps ---
    if (adminState[userId].step === 'awaiting_caption') {
        adminState[userId].caption = text;
        adminState[userId].step = 'awaiting_file';
        bot.sendMessage(chatId, 'Caption received. Please send the File (document) for the source code.');
    } else if (adminState[userId].step === 'awaiting_file') {
        // Handle file upload - requires bot to download and save, or store file_id
        // For simplicity, we'll ask for a file link if direct upload is too complex.
        // If user sends a document, capture its file_id.
        if (msg.document) {
            adminState[userId].fileId = msg.document.file_id;
            adminState[userId].fileName = msg.document.file_name;
            adminState[userId].step = 'awaiting_cost';
            bot.sendMessage(chatId, 'File received. Now, please send the Unlock Cost (points).');
        } else {
            bot.sendMessage(chatId, 'Please send a file (document). Send /cancel to stop.');
        }
    } else if (adminState[userId].step === 'awaiting_cost') {
        const cost = parseInt(text);
        if (!isNaN(cost) && cost >= 0) {
            adminState[userId].unlockCost = cost;
            adminState[userId].step = 'confirmation';

            // Confirm details before saving
            let confirmationMessage = `Please confirm:\nImage ID: ${adminState[userId].imageFileId || 'N/A'}\nCaption: ${adminState[userId].caption}\nFile Name: ${adminState[userId].fileName || 'N/A'}\nFile ID: ${adminState[userId].fileId || 'N/A'}\nUnlock Cost: ${adminState[userId].unlockCost}\n\nType 'confirm' to save, or 'cancel' to abort.`;
            bot.sendMessage(chatId, confirmationMessage);
        } else {
            bot.sendMessage(chatId, 'Invalid cost. Please enter a valid number for points.');
        }
    } else if (adminState[userId].step === 'confirmation') {
        if (text.toLowerCase() === 'confirm') {
            try {
                const newSourceCode = {
                    // Use a consistent ID generation strategy if possible
                    id: Date.now().toString(),
                    caption: adminState[userId].caption,
                    imageFileId: adminState[userId].imageFileId || null,
                    fileId: adminState[userId].fileId || null,
                    fileName: adminState[userId].fileName || null,
                    unlockCost: adminState[userId].unlockCost
                };
                await addSourceCode(newSourceCode);
                bot.sendMessage(chatId, 'Source code added successfully!');
            } catch (error) {
                console.error("Error adding source code:", error);
                bot.sendMessage(chatId, 'Failed to add source code. Please check logs.');
            } finally {
                delete adminState[userId]; // Clean up state
            }
        } else if (text.toLowerCase() === 'cancel') {
            bot.sendMessage(chatId, 'Operation cancelled.');
            delete adminState[userId];
        } else {
            bot.sendMessage(chatId, 'Please type "confirm" or "cancel".');
        }
    }

    // --- Handle Remove Source Code Flow ---
    if (adminState[userId].step === 'awaiting_remove_confirmation') {
        if (text.toLowerCase() === 'yes') {
            const sourceCodeIdToRemove = adminState[userId].sourceCodeIdToRemove;
            try {
                await removeSourceCode(sourceCodeIdToRemove);
                bot.sendMessage(chatId, `Source code with ID ${sourceCodeIdToRemove} removed successfully.`);
            } catch (error) {
                console.error("Error removing source code:", error);
                bot.sendMessage(chatId, 'Failed to remove source code.');
            } finally {
                delete adminState[userId];
            }
        } else if (text.toLowerCase() === 'no') {
            bot.sendMessage(chatId, 'Removal cancelled.');
            delete adminState[userId];
        } else {
            bot.sendMessage(chatId, 'Please type "yes" or "no".');
        }
    }

    // --- Handle Set Referral Reward ---
    if (adminState[userId].step === 'awaiting_referral_reward') {
        const reward = parseInt(text);
        if (!isNaN(reward) && reward >= 0) {
            await setReferralCoinReward(reward);
            bot.sendMessage(chatId, `Referral coin reward set to ${reward} SpyCoin.`);
            delete adminState[userId];
        } else {
            bot.sendMessage(chatId, 'Invalid reward amount. Please enter a non-negative number.');
        }
    }

    // --- Handle Add/Remove User Balance ---
    if (adminState[userId].step === 'awaiting_user_id_for_balance') {
        const targetUserId = parseInt(text);
        if (!isNaN(targetUserId)) {
            adminState[userId].targetUserId = targetUserId;
            adminState[userId].step = 'awaiting_balance_amount';
            bot.sendMessage(chatId, `User ID ${targetUserId} selected. Now enter the amount to add/remove (e.g., +100 or -50).`);
        } else {
            bot.sendMessage(chatId, 'Invalid User ID. Please enter a valid Telegram User ID (numbers only).');
        }
    } else if (adminState[userId].step === 'awaiting_balance_amount') {
        const amountText = text;
        const amount = parseInt(amountText);
        if (!isNaN(amount)) {
            try {
                const targetUser = await getUser(adminState[userId].targetUserId);
                const newBalance = targetUser.balance + amount;
                await updateUser(adminState[userId].targetUserId, { balance: newBalance });
                bot.sendMessage(chatId, `Balance updated for user ${adminState[userId].targetUserId}. New balance: ${newBalance} SpyCoin.`);
            } catch (error) {
                console.error("Error updating user balance:", error);
                bot.sendMessage(chatId, 'Failed to update user balance.');
            } finally {
                delete adminState[userId];
            }
        } else {
            bot.sendMessage(chatId, 'Invalid amount. Please enter a number (e.g., +50, -20).');
        }
    }

    // --- Handle Add Channel ---
    if (adminState[userId].step === 'awaiting_channel_username_for_add') {
        if (!text.startsWith('@')) return bot.sendMessage(chatId, 'Invalid channel username. It must start with "@".');
        adminState[userId].channelUsername = text;
        adminState[userId].step = 'awaiting_channel_link_for_add';
        bot.sendMessage(chatId, `Channel username '${text}' received. Now, please send the Channel Link (e.g., https://t.me/yourchannel).`);
    } else if (adminState[userId].step === 'awaiting_channel_link_for_add') {
        if (!text.startsWith('http')) return bot.sendMessage(chatId, 'Invalid link format. Please provide a valid URL.');
        try {
            const added = await addChannel(adminState[userId].channelUsername, text);
            if (added) {
                bot.sendMessage(chatId, `Channel '${adminState[userId].channelUsername}' with link '${text}' added successfully!`);
            } else {
                bot.sendMessage(chatId, `Channel '${adminState[userId].channelUsername}' already exists.`);
            }
        } catch (error) {
            console.error("Error adding channel:", error);
            bot.sendMessage(chatId, 'Failed to add channel.');
        } finally {
            delete adminState[userId];
        }
    }
});

// --- Admin Menu Navigation Handlers ---

// Back to Admin Menu
bot.onText(/Back to Admin Menu/, (msg) => {
    const adminMenuKeyboard = [
        [{ text: 'Manage Source Codes' }],
        [{ text: 'Manage Channels' }],
        [{ text: 'Manage Users' }],
        [{ text: 'Settings' }]
    ];
    bot.sendMessage(msg.chat.id, '🌟 Welcome back to the Admin Panel!', {
        reply_markup: {
            keyboard: adminMenuKeyboard,
            one_time_keyboard: true,
            resize_keyboard: true
        }
    });
});

// Handle 'Manage Channels' from Admin Menu
bot.onText(/Manage Channels/, async (msg) => {
    const channelAdminKeyboard = [
        [{ text: 'Add New Channel' }],
        [{ text: 'Remove Channel' }],
        [{ text: 'List Channels' }],
        [{ text: 'Back to Admin Menu' }]
    ];
    bot.sendMessage(msg.chat.id, 'Choose an action for Channels:', {
        reply_markup: {
            keyboard: channelAdminKeyboard,
            one_time_keyboard: true,
            resize_keyboard: true
        }
    });
});

// Handle 'Add New Channel'
bot.onText(/Add New Channel/, (msg) => {
    adminState[msg.from.id] = { step: 'awaiting_channel_username_for_add' };
    bot.sendMessage(msg.chat.id, 'Please send the Channel Username (e.g., @yourchannelname).');
});

// Handle 'Remove Channel'
bot.onText(/Remove Channel/, async (msg) => {
    const channels = await getChannels();
    if (channels.length === 0) {
        return bot.sendMessage(msg.chat.id, 'No channels added yet.');
    }
    const removeChannelKeyboard = channels.map(channel => [
        { text: `Remove ${channel.username}` } // Button text includes username
    ]);
    removeChannelKeyboard.push([{ text: 'Back to Channel Admin Menu' }]);
    bot.sendMessage(msg.chat.id, 'Select a channel to remove:', {
        reply_markup: {
            keyboard: removeChannelKeyboard,
            one_time_keyboard: true,
            resize_keyboard: true
        }
    });
});

// Process removal of a channel after button press
bot.onText(/Remove @.+/, async (msg) => {
    const channelUsernameToRemove = msg.text.replace('Remove ', '');
    const removed = await removeChannel(channelUsernameToRemove);
    if (removed) {
        bot.sendMessage(msg.chat.id, `${channelUsernameToRemove} removed successfully.`);
    } else {
        bot.sendMessage(msg.chat.id, `${channelUsernameToRemove} not found.`);
    }
    // Reset admin state or return to menu
    delete adminState[msg.from.id];
    // Optionally show channel admin menu again
    const channelAdminKeyboard = [[{ text: 'Add New Channel' }], [{ text: 'Remove Channel' }], [{ text: 'List Channels' }], [{ text: 'Back to Admin Menu' }]];
    bot.sendMessage(msg.chat.id, 'Choose an action for Channels:', { reply_markup: { keyboard: channelAdminKeyboard, one_time_keyboard: true, resize_keyboard: true } });
});

// Handle 'List Channels'
bot.onText(/List Channels/, async (msg) => {
    const channels = await getChannels();
    if (channels.length === 0) {
        bot.sendMessage(msg.chat.id, 'No channels added yet.');
    } else {
        let message = "Current Channels:\n";
        channels.forEach(c => message += `- ${c.username} (${c.link})\n`);
        bot.sendMessage(msg.chat.id, message);
    }
});


// Handle 'Remove Source Code'
bot.onText(/Remove Source Code/, async (msg) => {
    const sourceCodes = await getSourceCodes();
    if (sourceCodes.length === 0) {
        return bot.sendMessage(msg.chat.id, 'No source codes available to remove.');
    }
    const removeSCKeyboard = sourceCodes.map(sc => [
        { text: `Remove SC ID: ${sc.id} (${sc.caption.substring(0, 20)}...)` }
    ]);
    removeSCKeyboard.push([{ text: 'Back to Source Code Admin Menu' }]);
    bot.sendMessage(msg.chat.id, 'Select a source code to remove:', {
        reply_markup: {
            keyboard: removeSCKeyboard,
            one_time_keyboard: true,
            resize_keyboard: true
        }
    });
});

// Process removal of source code after button press
bot.onText(/Remove SC ID: (\d+)/, async (msg, match) => {
    const sourceCodeIdToRemove = match[1];
    adminState[msg.from.id] = { step: 'awaiting_remove_confirmation', sourceCodeIdToRemove: sourceCodeIdToRemove };
    bot.sendMessage(msg.chat.id, `Are you sure you want to remove Source Code ID ${sourceCodeIdToRemove}? Type 'yes' or 'no'.`);
});

// Handle 'Set Referral Reward'
bot.onText(/Settings/, async (msg) => {
    const settingsKeyboard = [
        [{ text: 'Set Referral Reward' }],
        [{ text: 'Back to Admin Menu' }]
    ];
    bot.sendMessage(msg.chat.id, 'Choose a setting:', {
        reply_markup: {
            keyboard: settingsKeyboard,
            one_time_keyboard: true,
            resize_keyboard: true
        }
    });
});

bot.onText(/Set Referral Reward/, (msg) => {
    adminState[msg.from.id] = { step: 'awaiting_referral_reward' };
    bot.sendMessage(msg.chat.id, 'Enter the new referral reward amount (in SpyCoin):');
});

// Handle 'Manage Users'
bot.onText(/Manage Users/, async (msg) => {
    const userAdminKeyboard = [
        [{ text: 'Add/Remove User Balance' }],
        [{ text: 'Back to Admin Menu' }]
    ];
    bot.sendMessage(msg.chat.id, 'Choose a user management action:', {
        reply_markup: {
            keyboard: userAdminKeyboard,
            one_time_keyboard: true,
            resize_keyboard: true
        }
    });
});

bot.onText(/Add\/Remove User Balance/, (msg) => {
    adminState[msg.from.id] = { step: 'awaiting_user_id_for_balance' };
    bot.sendMessage(msg.chat.id, 'Please enter the User ID (Chat ID) of the user whose balance you want to modify.');
});

// --- General Admin Menu Navigation ---
bot.onText(/Back to Source Code Admin Menu/, async (msg) => {
    const adminMenuKeyboard = [
        [{ text: 'Manage Source Codes' }],
        [{ text: 'Manage Channels' }],
        [{ text: 'Manage Users' }],
        [{ text: 'Settings' }]
    ];
    bot.sendMessage(msg.chat.id, 'Returning to Admin Panel...', {
        reply_markup: {
            keyboard: adminMenuKeyboard,
            one_time_keyboard: true,
            resize_keyboard: true
        }
    });
});

bot.onText(/Back to Channel Admin Menu/, async (msg) => {
     const adminMenuKeyboard = [
        [{ text: 'Manage Source Codes' }],
        [{ text: 'Manage Channels' }],
        [{ text: 'Manage Users' }],
        [{ text: 'Settings' }]
    ];
    bot.sendMessage(msg.chat.id, 'Returning to Admin Panel...', {
        reply_markup: {
            keyboard: adminMenuKeyboard,
            one_time_keyboard: true,
            resize_keyboard: true
        }
    });
});

bot.onText(/Back to Settings/, async (msg) => {
     const adminMenuKeyboard = [
        [{ text: 'Manage Source Codes' }],
        [{ text: 'Manage Channels' }],
        [{ text: 'Manage Users' }],
        [{ text: 'Settings' }]
    ];
    bot.sendMessage(msg.chat.id, 'Returning to Admin Panel...', {
        reply_markup: {
            keyboard: adminMenuKeyboard,
            one_time_keyboard: true,
            resize_keyboard: true
        }
    });
});


// --- Error Handling ---
bot.on('polling_error', (error) => { console.error('Polling error:', error.code, error.message); });
bot.on('webhook_error', (error) => { console.error('Webhook error:', error.code, error.message); });
bot.on('error', (error) => { console.error('General error:', error); });


// --- Start Server and Bot ---
app.get('/admin', (req, res) => {
    // Redirect to the actual admin HTML if needed, or just serve bot commands
    res.redirect('/admin.html'); // Assuming admin.html is in public folder
});

// Admin Panel POST routes (for forms if you extend admin.html)
app.post('/admin/addchannel', async (req, res) => {
    // This route might not be directly used if admin panel is purely bot-based.
    // If you use admin.html with forms, implement auth here.
    const { channelUsername, channelLink } = req.body;
    if (!channelUsername || !channelUsername.startsWith('@') || !channelLink.startsWith('http')) {
        return res.status(400).send("Invalid input.");
    }
    const added = await addChannel(channelUsername, channelLink);
    if (added) {
        res.redirect(`/admin.html?message=Channel ${channelUsername} added successfully!`);
    } else {
        res.redirect(`/admin.html?message=Channel ${channelUsername} already exists.`);
    }
});

// Add other admin POST routes as needed (e.g., setReferralReward, updateBalance)

app.listen(port, () => {
    console.log(`Express server running on port ${port}`);
});

bot.startPolling().then(() => {
    console.log('Telegram Bot is running and polling...');
}).catch(err => {
    console.error("Failed to start Telegram Bot polling:", err);
    process.exit(1);
});
