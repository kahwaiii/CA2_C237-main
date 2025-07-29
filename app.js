//--------------------------------------------------------------------
//  app.js  –  shorter, promise-based, matches your existing EJS views
//--------------------------------------------------------------------
const express        = require('express');
const expressLayouts = require('express-ejs-layouts');
const session        = require('express-session');
const flash          = require('connect-flash');
const bcrypt         = require('bcrypt');
const mysql          = require('mysql2/promise');
const path           = require('path');
const cookieParser = require('cookie-parser');

const app  = express();
app.use(cookieParser());
const pool = mysql.createPool({
  host: 'c237-all.mysql.database.azure.com',
  user: 'c237admin',
  password: 'c2372025!',
  database: 'petadopt',
  port: 3306,

  waitForConnections: true,   // queue additional requests once limit is reached
  connectionLimit: 5,         // ← don’t open more than 5 connections
  queueLimit: 0       
});

const SLOTS = [
  '09:15:00','10:00:00','10:45:00','11:30:00','12:15:00',
  '13:00:00','13:45:00','14:30:00','15:15:00','16:00:00',
  '16:45:00','17:30:00','18:00:00'
];

/* ───── Generic helpers ───── */
const q = (sql, params = []) => pool.query(sql, params).then(([rows]) => rows);
const needAuth = admin =>
  (req, res, next) => (!req.session.user || (admin && !req.session.user.admin))
    ? res.redirect('/login') : next();
const slotTaken = (petId, dt) =>
  q('SELECT id FROM appointments WHERE pet_id=? AND appointment_dt=? AND status<>"cancelled"', [petId, dt])
  .then(r => r.length);
const adopted = petId =>
  q('SELECT id FROM pet_adoptions WHERE pet_id=? AND status="approved"', [petId])
  .then(r => r.length);
const reserved = petId =>
  q('SELECT 1 FROM appointments WHERE pet_id=? AND status="scheduled" LIMIT 1',
    [petId]).then(r => r.length);

/* ───── Express basics ───── */
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layout');

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: 'your-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production' }
}));
app.use(flash());
app.use((req, res, next) => {
  res.locals.user     = req.session.user;
  res.locals.messages = req.flash();
  next();
});

/* ───── Public pages ───── */
app.get('/', async (req, res) => {
  let recentlyViewed = [];
  if (req.cookies.recentlyViewed) {
    try {
      recentlyViewed = JSON.parse(req.cookies.recentlyViewed);
    } catch (e) {
      recentlyViewed = [];
    }
  }
  recentlyViewed = recentlyViewed.slice(0, 3);

  let recentlyViewedPets = [];
  if (recentlyViewed.length > 0) {
    // Fetch pets by IDs and preserve order
    const pets = await q('SELECT * FROM pets WHERE id IN (?)', [recentlyViewed]);
    recentlyViewedPets = recentlyViewed.map(id => pets.find(p => p.id == id)).filter(Boolean);
  }

  res.render('index', {
    title: 'Home',
    recentlyViewedPets
  });
});

app.get('/pets', async (req, res) => {
  const filter = req.query.type;
  const search = req.query.search;
  const sort = req.query.sort;

  let query = 'SELECT * FROM pets';
  const values = [];
  const conditions = [];

  if (filter) {
    conditions.push('type = ?');
    values.push(filter.charAt(0).toUpperCase() + filter.slice(1));
  }
  if (search) {
    conditions.push('name LIKE ?');
    values.push('%' + search + '%');
  }
  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }

  // 🛑 Ensure the column exists in your DB
  if (sort === 'oldest') query += ' ORDER BY created_at ASC';
  else if (sort === 'youngest') query += ' ORDER BY created_at DESC';
  else if (sort === 'az') query += ' ORDER BY name ASC';
  else if (sort === 'za') query += ' ORDER BY name DESC';

  try {
    console.log('QUERY:', query, values);
    const pets = await q(query, values);
    res.render('pets', {
      title: 'Browse Pets',
      pets,
      filter: filter || null,
      search: search || '',
      sort: sort || ''
    });
  } catch (err) {
    console.error('❌ Database error:', err.message); // More helpful
    res.status(500).send('Database error occurred');
  }
});

app.get('/pets/:id', async (req, res) => {
  try {
    const petId = req.params.id;
    const rows = await q('SELECT * FROM pets WHERE id=?', [petId]);
    if (!rows.length) {
      req.flash('danger', 'Pet not found');
      return res.render('petDetails', { title: 'Details', pet: null });
    }

    // Track recently viewed pets using cookies
    let viewed = [];
    if (req.cookies.recentlyViewed) {
      try {
        viewed = JSON.parse(req.cookies.recentlyViewed);
      } catch (e) {
        viewed = [];
      }
    }
    // Add current petId to the front, remove duplicates, and limit to 3
    viewed = [petId, ...viewed.filter(id => id !== petId)].slice(0, 3);
    res.cookie('recentlyViewed', JSON.stringify(viewed), { maxAge: 7 * 24 * 60 * 60 * 1000 }); // 1 week

    res.render('petDetails', { title: rows[0].name, pet: rows[0] });
  } catch (err) {
    console.error('❌ Error fetching pet:', err);
    res.status(500).send('Database error occurred');
  }
});


/* ───── Registration & login ───── */
app.route('/register')
.get((_, res) => res.render('register', { title: 'Register', error: null }))
.post(async (req, res) => {
  const { name, email, password, phone } = req.body; // <-- Add this line
  if (!name || !email || !password)
    return res.render('register', { title: 'Register', error: 'All fields required' });
  try {
    await q('INSERT INTO users(name,email,password,phone) VALUES(?,?,?,?)',
            [name, email, await bcrypt.hash(password, 10), phone || null]);
    res.redirect('/login');
  } catch {
    res.render('register', { title: 'Register', error: 'Email already in use' });
  }
});

app.route('/login')
.get((req, res) => {
  // Only pre-fill if cookie exists
  res.render('login', {
    title: 'Login',
    error: null,
    rememberedEmail: req.cookies.rememberedEmail || ''
  });
})
.post(async (req, res) => {
  const { email, password, userType, rememberMe } = req.body;
  const table = userType === 'admin' ? 'admins' : 'users';
  const rows  = await q(`SELECT * FROM ${table} WHERE email=?`, [email]);
  if (!rows.length) return res.render('login', { title: 'Login', error: 'Invalid credentials', rememberedEmail: email });
  const user = rows[0];
  const ok   = userType === 'admin' ? password === user.password
                                    : await bcrypt.compare(password, user.password);
  if (!ok) return res.render('login', { title: 'Login', error: 'Invalid credentials', rememberedEmail: email });

  req.session.user = { id: user.id, name: user.name, admin: userType === 'admin' };

  // Remember Me logic
  if (rememberMe) {
    res.cookie('rememberedEmail', email, { maxAge: 30 * 24 * 60 * 60 * 1000 }); // 30 days
  } else {
    res.clearCookie('rememberedEmail');
  }

  res.redirect(userType === 'admin' ? '/dashboard' : '/pets');
});

app.get('/logout', (req, res) => req.session.destroy(() => res.clearCookie('connect.sid').redirect('/')));

/* ───── Admin dashboard + pets CRUD ───── */
app.get('/dashboard', needAuth(true), async (req, res) => {
  const [{ totalPets }]        = await q('SELECT COUNT(*) totalPets FROM pets');
  const [{ totalUsers }]       = await q('SELECT COUNT(*) totalUsers FROM users');
  const [{ totalAppointments }] = await q('SELECT COUNT(*) totalAppointments FROM appointments');
  const recentAppointments = await q(
    `SELECT a.id,a.appointment_dt,a.status,u.name user_name,p.name pet_name
     FROM appointments a
     LEFT JOIN users  u ON a.user_id=u.id
     LEFT JOIN pets   p ON a.pet_id=p.id
     ORDER BY a.appointment_dt DESC LIMIT 5`);
  res.render('dashboard', {
    title: 'Admin Dashboard',
    stats: { totalPets, totalUsers, totalAppointments },
    recentAppointments
  });
});

/* admin-pets.ejs list */
app.get('/admin/pets', needAuth(true), async (_, res) =>
  res.render('admin-pets', { title: 'Manage Pets', pets: await q('SELECT * FROM pets') })
);

/* add-pet.ejs */
app.route('/admin/pets/add')
.get(needAuth(true), (_, res) =>
  res.render('add-pet', { title: 'Add Pet', error: null, allowedTypes: ['Dog', 'Cat', 'Rabbit'] }))
.post(needAuth(true), async (req, res) => {
  const { name, type, breed, age, image, description } = req.body;
  if (!name || !type || !breed || !age || !['Dog','Cat','Rabbit'].includes(type))
    return res.render('add-pet', { title: 'Add Pet', error: 'Invalid input', allowedTypes: ['Dog','Cat','Rabbit'] });
  try {
    await q('INSERT INTO pets(name,type,breed,age,image,description) VALUES(?,?,?,?,?,?)',
            [name,type,breed,age,image||null,description||'']);
    res.redirect('/admin/pets');
  } catch {
    res.render('add-pet', { title: 'Add Pet', error: 'Error adding pet', allowedTypes: ['Dog','Cat','Rabbit'] });
  }
});

/* edit-pets.ejs (plural name kept) */
app.route('/admin/pets/edit/:id')
.get(needAuth(true), async (req, res) => {
  const rows = await q('SELECT * FROM pets WHERE id=?', [req.params.id]);
  if (!rows.length) return res.status(404).send('Not found');
  res.render('edit-pets', { title: 'Edit Pet', pet: rows[0], error: null, allowedTypes: ['Dog','Cat','Rabbit'] });
})
.post(needAuth(true), async (req, res) => {
  const { name, type, breed, age, image, description } = req.body, id = req.params.id;
  if (!name || !type || !breed || !age || !['Dog','Cat','Rabbit'].includes(type))
    return res.render('edit-pets', { title: 'Edit Pet', pet: { id,name,type,breed,age,image,description },
                                     error: 'Invalid input', allowedTypes: ['Dog','Cat','Rabbit'] });
  await q('UPDATE pets SET name=?,type=?,breed=?,age=?,image=?,description=? WHERE id=?',
         [name,type,breed,age,image||null,description||'',id]);
  res.redirect('/admin/pets');
});

app.post('/admin/pets/delete/:id', needAuth(true),
  async (req, res) => { await q('DELETE FROM pets WHERE id=?', [req.params.id]); res.redirect('/admin/pets'); });

/* ───── User profile ───── */
/* ───── User profile ───── */
app.route('/profile')
.get(needAuth(false), async (req, res) => {
  const [user] = await q('SELECT * FROM users WHERE id=?', [req.session.user.id]);

  // NEW: grab this user’s appointments + pet names
  const appointments = await q(
    `SELECT a.id, a.appointment_dt, a.status,
            p.name AS pet_name
     FROM appointments a
     JOIN pets p      ON a.pet_id = p.id
     WHERE a.user_id = ?
     ORDER BY a.appointment_dt DESC`,
    [user.id]
  );

  res.render('profile', {
    title: 'Profile',
    user,
    appointments,     // pass to EJS
    error: null
  });
})

.post(needAuth(false), async (req, res) => {
  const { name, email, phone, password } = req.body;
  if (!name || !email)
    return res.render('profile', {
      title: 'Profile',
      user: req.body,
      appointments: await q(   // keep list when re-rendering with an error
        `SELECT a.id, a.appointment_dt, a.status, p.name AS pet_name
         FROM appointments a
         JOIN pets p ON a.pet_id = p.id
         WHERE a.user_id = ? ORDER BY a.appointment_dt DESC`,
        [req.session.user.id]
      ),
      error: 'Name & email required'
    });

  /* …rest of the update logic stays the same… */
});

/* ───── Appointment booking only (no edit) ───── */
app.route('/appointments/schedule/:petId')
.get(needAuth(false), async (req, res) => {
  const petId = req.params.petId;
  const [pet] = await q('SELECT * FROM pets WHERE id=?', [petId]);
  if (!pet || await adopted(petId) || await reserved(petId))
    return res.render('appointment',
            { title:'Book', pet:null, bookedSlots:[] });

  const booked = (await q(
    'SELECT appointment_dt FROM appointments WHERE pet_id=? AND status<>"cancelled" AND appointment_dt BETWEEN ? AND ?',
    [petId, '2025-07-29', '2025-08-31']
  )).map(r => r.appointment_dt.toISOString().slice(0,19).replace('T',' '));

  res.render('appointment', { title: 'Book', pet, bookedSlots: booked });
})
.post(needAuth(false), async (req, res) => {
  const { appointment_dt } = req.body;
  const petId  = req.params.petId;
  const userId = req.session.user.id;

  if (!appointment_dt) {
    req.flash('danger', 'Select date/time');
    return res.redirect('back');
  }

  // NEW: also block if the pet is already reserved
  if (await reserved(petId) ||
      await slotTaken(petId, appointment_dt) ||
      await adopted(petId)) {
    req.flash('danger', 'Pet already reserved or slot taken');
    return res.redirect('back');
  }

  const when = new Date(appointment_dt + '+08:00');
  if (when < new Date() || when > new Date('2025-08-31T23:59:59+08:00')) {
    req.flash('danger', 'Date outside booking window');
    return res.redirect('back');
  }

  await q(
    'INSERT INTO appointments (user_id, pet_id, appointment_dt, status) VALUES (?, ?, ?, "scheduled")',
    [userId, petId, appointment_dt]
  );
  req.flash('success', 'Appointment booked!');
  res.redirect('/profile');
});


/* AJAX for time-slot dropdown -> appointment.ejs */
app.get('/availableSlots', needAuth(false), async (req, res) => {
  const { date, petId } = req.query;
  if (!date || !petId) return res.json([]);
  const booked = (await q(
    'SELECT appointment_dt FROM appointments WHERE DATE(appointment_dt)=? AND pet_id=? AND status<>"cancelled"',
    [date, petId]
  )).map(r => r.appointment_dt.toTimeString().split(' ')[0]);
  res.json(SLOTS.filter(t => !booked.includes(t)));
});

/* Cancel appointment */
app.post('/appointments/cancel/:id', needAuth(false), async (req, res) => {
  const appointmentId = req.params.id;
  const userId = req.session.user.id;

  // Ensure the appointment belongs to the user
  const [appointment] = await q('SELECT user_id FROM appointments WHERE id = ?', [appointmentId]);
  if (!appointment || appointment.user_id !== userId) {
    req.flash('danger', 'Unauthorized or appointment not found');
    return res.redirect('/profile');
  }

  // Update status to cancelled (or DELETE if you prefer)
  await q('UPDATE appointments SET status = "cancelled" WHERE id = ?', [appointmentId]);
  // Alternatively, to delete: await q('DELETE FROM appointments WHERE id = ?', [appointmentId]);

  req.flash('success', 'Appointment cancelled successfully');
  res.redirect('/profile');
});

/* ───── Boot up ───── */
app.listen(process.env.PORT || 3000, () => console.log('🐾  PetAdopt server running on 3000'));
