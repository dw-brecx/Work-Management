require('dotenv').config();
const { MongoClient, ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/syruvia';
let _db;

async function connect() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  _db = client.db('syruvia');
}

function col(name) { return _db.collection(name); }

function nowStr() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

async function init() {
  await connect();

  await col('users').createIndex({ email: 1 }, { unique: true });
  await col('invites').createIndex({ token: 1 }, { unique: true });
  await col('departments').createIndex({ name: 1 }, { unique: true });
  await col('ticket_assignees').createIndex({ ticket_id: 1, user_name: 1 }, { unique: true });
  await col('ticket_details').createIndex({ ticket_id: 1 }, { unique: true });

  if (!await col('users').findOne({ email: 'admin@worknest.com' })) {
    await col('users').insertOne({
      name: 'Admin', email: 'admin@worknest.com',
      password_hash: bcrypt.hashSync('admin123', 10),
      role: 'Administrator', dept: 'Management', color: '#2563eb', perm_role: 'Owner',
      created_at: nowStr()
    });
  }

  const defaults = ['Engineering', 'Design', 'Support', 'Operations', 'Management', 'General'];
  for (const name of defaults) {
    await col('departments').updateOne({ name }, { $setOnInsert: { name } }, { upsert: true });
  }
}

module.exports = { col, init, ObjectId, nowStr };
