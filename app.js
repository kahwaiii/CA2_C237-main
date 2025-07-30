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
const cookieParser   = require('cookie-parser');
const multer         = require('multer');
const fs             = require('fs');

const app  = express();
app.use(cookieParser());

const pool = mysql.createPool({
  host: 'c237-all.mysql.database.azure.com',
  user: 'c237admin',
  password: 'c2372025!',
  database: 'petadopt',
  port: 3306,
  waitForConnections: true,
  connectionLimit: 5,
  queueLimit: 0       
});

// Multer configuration for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = path.join(__dirname, 'public/images/animals');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname);
    // Use timestamp for new pets, pet ID for edits
    const petId = req.params.id || `new-${Date.now()}`;
    const filename = `animal-${petId}-${Date.now()}${ext}`;
    cb(null, filename);
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  },
  fileFilter: function (req, file, cb) {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed!'), false);
    }
  }
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
    if (filter === 'other') {
      conditions[conditions.length - 1] = 'type NOT IN (?, ?)';
      values.push('Dog', 'Cat');
    } else {
      values.push(filter.charAt(0).toUpperCase() + filter.slice(1));
    }
  }
  if (search) {
    conditions.push('name LIKE ?');
    values.push('%' + search + '%');
  }
  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }

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
    console.error('❌ Database error:', err.message);
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
    viewed = [petId, ...viewed.filter(id => id !== petId)].slice(0, 3);
    res.cookie('recentlyViewed', JSON.stringify(viewed), { maxAge: 7 * 24 * 60 * 60 * 1000 });

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
  const { name, email, password, phone } = req.body;
  
  if (!name || !email || !password) {
    return res.render('register', { title: 'Register', error: 'All fields required' });
  }
  
  if (password.length < 6) {
    return res.render('register', { title: 'Register', error: 'Password must be at least 6 characters' });
  }
  
  try {
    await q('INSERT INTO users(name,email,password,phone) VALUES(?,?,?,?)',
            [name, email, await bcrypt.hash(password, 10), phone || null]);
    req.flash('success', 'Registration successful! Please log in.');
    res.redirect('/login');
  } catch (error) {
    console.error('❌ Registration error:', error);
    res.render('register', { title: 'Register', error: 'Email already in use' });
  }
});

app.route('/login')
.get((req, res) => {
  res.render('login', {
    title: 'Login',
    error: null,
    rememberedEmail: req.cookies.rememberedEmail || ''
  });
})
.post(async (req, res) => {
  const { email, password, rememberMe } = req.body;
  
  try {
    let rows = await q('SELECT * FROM admins WHERE email=?', [email]);
    let userType = 'admin';
    
    if (!rows.length) {
      rows = await q('SELECT * FROM users WHERE email=?', [email]);
      userType = 'user';
    }
    
    if (!rows.length) {
      return res.render('login', { 
        title: 'Login', 
        error: 'Invalid credentials', 
        rememberedEmail: email 
      });
    }
    
    const user = rows[0];
    
    const ok = userType === 'admin' 
      ? password === user.password
      : await bcrypt.compare(password, user.password);
      
    if (!ok) {
      return res.render('login', { 
        title: 'Login', 
        error: 'Invalid credentials', 
        rememberedEmail: email 
      });
    }

    req.session.user = { 
      id: user.id, 
      name: user.name, 
      email: user.email,
      admin: userType === 'admin' 
    };

    if (rememberMe) {
      res.cookie('rememberedEmail', email, { maxAge: 30 * 24 * 60 * 60 * 1000 });
    } else {
      res.clearCookie('rememberedEmail');
    }

    if (userType === 'admin') {
      res.redirect('/dashboard');
    } else {
      res.redirect('/');
    }
    
  } catch (err) {
    console.error('❌ Login error:', err);
    res.render('login', { 
      title: 'Login', 
      error: 'An error occurred during login', 
      rememberedEmail: email 
    });
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('❌ Logout error:', err);
      return res.redirect('/');
    }
    
    res.clearCookie('connect.sid');
    res.redirect('/');
  });
});

/* ───── Admin dashboard + pets CRUD ───── */
app.get('/dashboard', needAuth(true), async (req, res) => {
  const [{ totalPets }]        = await q('SELECT COUNT(*) totalPets FROM pets');
  const [{ totalUsers }]       = await q('SELECT COUNT(*) totalUsers FROM users');
  const [{ totalAppointments }] = await q('SELECT COUNT(*) totalAppointments FROM appointments');
  const recentAppointments = await q(
    `SELECT a.id, a.appointment_dt, a.status, 
            u.name as user_name, u.phone as user_phone,
            p.name as pet_name
     FROM appointments a
     LEFT JOIN users u ON a.user_id = u.id
     LEFT JOIN pets p ON a.pet_id = p.id
     ORDER BY a.appointment_dt DESC LIMIT 5`);
  res.render('dashboard', {
    title: 'Admin Dashboard',
    stats: { totalPets, totalUsers, totalAppointments },
    recentAppointments
  });
});

app.get('/admin/pets', needAuth(true), async (_, res) =>
  res.render('admin-pets', { title: 'Manage Pets', pets: await q('SELECT * FROM pets') })
);

app.route('/admin/pets/add')
.get(needAuth(true), (_, res) =>
  res.render('add-pet', { 
    title: 'Add Pet', 
    error: null, 
    allowedTypes: ['Dog', 'Cat', 'Others']
  })
)
.post(needAuth(true), upload.single('photoFile'), async (req, res) => {
  const { name, type, breed, age, image, description } = req.body;
  
  if (!name || !type || !breed || !age || !['Dog', 'Cat', 'Others'].includes(type)) {
    return res.render('add-pet', { 
      title: 'Add Pet', 
      error: 'Invalid input. Please check all fields.', 
      allowedTypes: ['Dog', 'Cat', 'Others']
    });
  }
  
  try {
    // Determine the image path
    let finalImagePath = image || null; // Use URL if provided
    
    // If a file was uploaded, use that instead
    if (req.file) {
      finalImagePath = `/images/animals/${req.file.filename}`;
    }
    
    await q('INSERT INTO pets(name,type,breed,age,image,description) VALUES(?,?,?,?,?,?)',
            [name, type, breed, age, finalImagePath, description || '']);
    
    req.flash('success', 'Pet added successfully!');
    res.redirect('/admin/pets');
    
  } catch (error) {
    console.error('❌ Error adding pet:', error);
    
    // Clean up uploaded file if database insert failed
    if (req.file) {
      const uploadedFilePath = path.join(__dirname, 'public/images/animals', req.file.filename);
      if (fs.existsSync(uploadedFilePath)) {
        fs.unlinkSync(uploadedFilePath);
      }
    }
    
    res.render('add-pet', { 
      title: 'Add Pet', 
      error: 'Error adding pet. Please try again.', 
      allowedTypes: ['Dog', 'Cat', 'Others']
    });
  }
});

app.route('/admin/pets/edit/:id')
.get(needAuth(true), async (req, res) => {
  const rows = await q('SELECT * FROM pets WHERE id=?', [req.params.id]);
  if (!rows.length) return res.status(404).send('Pet not found');
  res.render('edit-pets', { 
    title: 'Edit Pet', 
    pet: rows[0], 
    error: null, 
    allowedTypes: ['Dog', 'Cat', 'Others']
  });
})
.post(needAuth(true), upload.single('photoFile'), async (req, res) => {
  const { name, type, breed, age, image, description } = req.body;
  const id = req.params.id;
  
  if (!name || !type || !breed || !age || !['Dog', 'Cat', 'Others'].includes(type)) {
    return res.render('edit-pets', { 
      title: 'Edit Pet', 
      pet: { id, name, type, breed, age, image, description },
      error: 'Invalid input. Please check all fields.',
      allowedTypes: ['Dog', 'Cat', 'Others']
    });
  }
  
  try {
    // Determine the image path to use
    let finalImagePath = image || null; // Use URL if provided
    
    // If a file was uploaded, use the uploaded file path instead
    if (req.file) {
      finalImagePath = `/images/animals/${req.file.filename}`;
      
      // Optional: Delete old image file if it exists and is a local file
      const [currentPet] = await q('SELECT image FROM pets WHERE id=?', [id]);
      if (currentPet && currentPet.image && currentPet.image.startsWith('/images/animals/')) {
        const oldImagePath = path.join(__dirname, 'public', currentPet.image);
        if (fs.existsSync(oldImagePath)) {
          fs.unlinkSync(oldImagePath);
        }
      }
    }
    
    await q('UPDATE pets SET name=?,type=?,breed=?,age=?,image=?,description=? WHERE id=?',
           [name, type, breed, age, finalImagePath, description || '', id]);
    
    req.flash('success', 'Pet updated successfully!');
    res.redirect('/admin/pets');
    
  } catch (error) {
    console.error('❌ Error updating pet:', error);
    
    // If file was uploaded but database update failed, clean up the file
    if (req.file) {
      const uploadedFilePath = path.join(__dirname, 'public/images/animals', req.file.filename);
      if (fs.existsSync(uploadedFilePath)) {
        fs.unlinkSync(uploadedFilePath);
      }
    }
    
    res.render('edit-pets', { 
      title: 'Edit Pet', 
      pet: { id, name, type, breed, age, image, description },
      error: 'Error updating pet. Please try again.',
      allowedTypes: ['Dog', 'Cat', 'Others']
    });
  }
});

app.post('/admin/pets/delete/:id', needAuth(true), async (req, res) => {
  try {
    // Get pet info to delete image file if needed
    const [pet] = await q('SELECT image FROM pets WHERE id=?', [req.params.id]);
    
    if (pet && pet.image && pet.image.startsWith('/images/animals/')) {
      const imagePath = path.join(__dirname, 'public', pet.image);
      if (fs.existsSync(imagePath)) {
        fs.unlinkSync(imagePath);
      }
    }
    
    await q('DELETE FROM pets WHERE id=?', [req.params.id]);
    req.flash('success', 'Pet deleted successfully!');
  } catch (error) {
    console.error('❌ Error deleting pet:', error);
    req.flash('danger', 'Error deleting pet');
  }
  res.redirect('/admin/pets');
});

/* ───── User profile ───── */
app.get('/profile', needAuth(false), async (req, res) => {
  const userId = req.session.user.id;
  
  // Get user data
  const [user] = await q('SELECT * FROM users WHERE id=?', [userId]);
  
  // Get user's appointments
  const appointments = await q(
    'SELECT a.*, p.name as pet_name FROM appointments a JOIN pets p ON a.pet_id = p.id WHERE a.user_id = ? ORDER BY a.appointment_dt DESC',
    [userId]
  );
  
  res.render('profile', {
    title: 'My Profile',
    user: user,
    appointments
  });
});

app.post('/profile/edit', needAuth(false), async (req, res) => {
  const { name, email, phone, password } = req.body;
  const userId = req.session.user.id;
  
  try {
    if (password && password.trim()) {
      // Update with new password
      const hashed = await bcrypt.hash(password, 10);
      await q('UPDATE users SET name=?, email=?, phone=?, password=? WHERE id=?', [name, email, phone, hashed, userId]);
    } else {
      // Update without changing password
      await q('UPDATE users SET name=?, email=?, phone=? WHERE id=?', [name, email, phone, userId]);
    }
    // Update session with new data
    req.session.user.name = name;
    req.session.user.email = email;
    req.flash('success', 'Profile updated successfully!');
  } catch (error) {
    console.error('❌ Profile update error:', error);
    req.flash('danger', 'Error updating profile');
  }
  res.redirect('/profile');
});

/* ───── Appointment booking ───── */
app.get('/appointments/schedule/:petId', needAuth(false), async (req, res) => {
  try {
    const petId = req.params.petId;
    
    // Validate that petId is a number
    if (!petId || isNaN(petId)) {
      console.log('❌ Invalid pet ID:', petId);
      req.flash('danger', 'Invalid pet ID');
      return res.redirect('/pets');
    }
    
    console.log('🔍 Loading appointment page for pet ID:', petId);
    
    // Get pet details
    const [pet] = await q('SELECT * FROM pets WHERE id = ?', [petId]);
    
    if (!pet) {
      console.log('❌ Pet not found:', petId);
      req.flash('danger', 'Pet not found');
      return res.redirect('/pets');
    }
    
    console.log('✅ Pet found:', pet.name);
    
    res.render('appointment', {
      title: `Book Appointment with ${pet.name}`,
      pet: pet
    });
    
  } catch (error) {
    console.error('❌ Error loading appointment page:', error);
    req.flash('danger', 'Error loading appointment page');
    res.redirect('/pets');
  }
});

app.post('/appointments/schedule/:petId', needAuth(false), async (req, res) => {
  const { appointment_dt } = req.body;
  const petId  = req.params.petId;
  const userId = req.session.user.id;

  if (!appointment_dt) {
    req.flash('danger', 'Select date/time');
    return res.redirect('back');
  }

  // Only check if this specific slot is taken
  if (await slotTaken(petId, appointment_dt)) {
    req.flash('danger', 'This time slot is already taken');
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

app.get('/availableSlots', needAuth(false), async (req, res) => {
  const { date, petId } = req.query;
  if (!date || !petId) return res.json([]);
  
  try {
    const booked = (await q(
      'SELECT appointment_dt FROM appointments WHERE DATE(appointment_dt)=? AND pet_id=? AND status<>"cancelled"',
      [date, petId]
    )).map(r => r.appointment_dt.toTimeString().split(' ')[0]);
    
    // Return available slots (filter out booked ones)
    const availableSlots = SLOTS.filter(slot => !booked.includes(slot));
    res.json(availableSlots);
    
  } catch (error) {
    console.error('❌ Error fetching available slots:', error);
    res.status(500).json([]);
  }
});

app.post('/appointments/cancel/:id', needAuth(false), async (req, res) => {
  const appointmentId = req.params.id;
  const userId = req.session.user.id;

  const [appointment] = await q('SELECT user_id FROM appointments WHERE id = ?', [appointmentId]);
  if (!appointment || appointment.user_id !== userId) {
    req.flash('danger', 'Unauthorized or appointment not found');
    return res.redirect('/profile');
  }

  await q('UPDATE appointments SET status = "cancelled" WHERE id = ?', [appointmentId]);
  req.flash('success', 'Appointment cancelled successfully');
  res.redirect('/profile');
});

/* ───── Admin user management ───── */
// Add these routes after your existing admin routes

/* ───── Admin user management ───── */
// Replace line around 600 in your app.js - the admin users route
app.get('/admin/users', needAuth(true), async (req, res) => {
  try {
    // Remove created_at from the SELECT query since the column doesn't exist
    const users = await q('SELECT id, name, email, phone FROM users ORDER BY id DESC');
    res.render('admin-users', { 
      title: 'Manage Users', 
      users 
    });
  } catch (error) {
    console.error('❌ Error fetching users:', error);
    req.flash('danger', 'Error loading users');
    res.redirect('/dashboard');
  }
});

// Add User
app.post('/admin/users/add', needAuth(true), async (req, res) => {
  const { name, email, phone, password } = req.body;
  
  if (!name || !email || !password) {
    req.flash('danger', 'Name, email and password are required');
    return res.redirect('/admin/users');
  }
  
  if (password.length < 6) {
    req.flash('danger', 'Password must be at least 6 characters');
    return res.redirect('/admin/users');
  }
  
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    await q('INSERT INTO users (name, email, phone, password) VALUES (?, ?, ?, ?)',
            [name, email, phone || null, hashedPassword]);
    req.flash('success', 'User added successfully!');
  } catch (error) {
    console.error('❌ Error adding user:', error);
    if (error.code === 'ER_DUP_ENTRY') {
      req.flash('danger', 'Email already exists');
    } else {
      req.flash('danger', 'Error adding user');
    }
  }
  res.redirect('/admin/users');
});

// Edit User
app.post('/admin/users/edit', needAuth(true), async (req, res) => {
  const { id, name, email, phone, password } = req.body;
  
  if (!name || !email) {
    req.flash('danger', 'Name and email are required');
    return res.redirect('/admin/users');
  }
  
  try {
    if (password && password.trim()) {
      if (password.length < 6) {
        req.flash('danger', 'Password must be at least 6 characters');
        return res.redirect('/admin/users');
      }
      const hashedPassword = await bcrypt.hash(password, 10);
      await q('UPDATE users SET name=?, email=?, phone=?, password=? WHERE id=?',
              [name, email, phone || null, hashedPassword, id]);
    } else {
      await q('UPDATE users SET name=?, email=?, phone=? WHERE id=?',
              [name, email, phone || null, id]);
    }
    req.flash('success', 'User updated successfully!');
  } catch (error) {
    console.error('❌ Error updating user:', error);
    if (error.code === 'ER_DUP_ENTRY') {
      req.flash('danger', 'Email already exists');
    } else {
      req.flash('danger', 'Error updating user');
    }
  }
  res.redirect('/admin/users');
});

// Delete User
app.post('/admin/users/delete', needAuth(true), async (req, res) => {
  const { id } = req.body;
  
  try {
    // Check if user has appointments
    const appointments = await q('SELECT COUNT(*) as count FROM appointments WHERE user_id = ?', [id]);
    if (appointments[0].count > 0) {
      req.flash('warning', 'Cannot delete user with existing appointments. Cancel appointments first.');
      return res.redirect('/admin/users');
    }
    
    await q('DELETE FROM users WHERE id = ?', [id]);
    req.flash('success', 'User deleted successfully!');
  } catch (error) {
    console.error('❌ Error deleting user:', error);
    req.flash('danger', 'Error deleting user');
  }
  res.redirect('/admin/users');
});

/* ───── Admin Appointments Management ───── */
app.get('/admin/appointments', needAuth(true), async (req, res) => {
  try {
    const appointments = await q(`
      SELECT a.id, a.appointment_dt, a.status, 
             u.name as user_name, u.email as user_email, u.phone as user_phone,
             p.name as pet_name, p.type as pet_type
      FROM appointments a
      LEFT JOIN users u ON a.user_id = u.id
      LEFT JOIN pets p ON a.pet_id = p.id
      ORDER BY a.appointment_dt DESC
    `);
    
    res.render('admin-appointments', { 
      title: 'Manage Appointments', 
      appointments 
    });
  } catch (error) {
    console.error('❌ Error fetching appointments:', error);
    req.flash('danger', 'Error loading appointments');
    res.redirect('/dashboard');
  }
});

// Edit appointment route
app.route('/admin/appointments/edit/:id')
.get(needAuth(true), async (req, res) => {
  try {
    const appointmentId = req.params.id;
    
    // Get appointment with user and pet details
    const [appointment] = await q(`
      SELECT a.*, 
             u.name as user_name, u.email as user_email, u.phone as user_phone,
             p.name as pet_name, p.type as pet_type
      FROM appointments a
      LEFT JOIN users u ON a.user_id = u.id
      LEFT JOIN pets p ON a.pet_id = p.id
      WHERE a.id = ?
    `, [appointmentId]);
    
    if (!appointment) {
      req.flash('danger', 'Appointment not found');
      return res.redirect('/admin/appointments');
    }
    
    // Get all users for dropdown
    const users = await q('SELECT id, name, email FROM users ORDER BY name');
    
    // Get all pets for dropdown
    const pets = await q('SELECT id, name, type FROM pets ORDER BY name');
    
    res.render('editappointment', {
      title: 'Edit Appointment',
      appointment,
      users,
      pets,
      error: null
    });
    
  } catch (error) {
    console.error('❌ Error loading appointment for edit:', error);
    req.flash('danger', 'Error loading appointment');
    res.redirect('/admin/appointments');
  }
})
.post(needAuth(true), async (req, res) => {
  const { user_id, pet_id, appointment_dt, status } = req.body;
  const appointmentId = req.params.id;
  
  if (!user_id || !pet_id || !appointment_dt || !status) {
    req.flash('danger', 'All fields are required');
    return res.redirect(`/admin/appointments/edit/${appointmentId}`);
  }
  
  try {
    // Check if the new time slot is available (if changed)
    const [currentAppointment] = await q('SELECT appointment_dt FROM appointments WHERE id = ?', [appointmentId]);
    
    if (currentAppointment.appointment_dt.toISOString().slice(0, 19).replace('T', ' ') !== appointment_dt) {
      // Time slot changed, check if new slot is available
      const conflictingAppointments = await q(
        'SELECT id FROM appointments WHERE pet_id = ? AND appointment_dt = ? AND status != "cancelled" AND id != ?',
        [pet_id, appointment_dt, appointmentId]
      );
      
      if (conflictingAppointments.length > 0) {
        req.flash('danger', 'This time slot is already booked for this pet');
        return res.redirect(`/admin/appointments/edit/${appointmentId}`);
      }
    }
    
    await q(
      'UPDATE appointments SET user_id = ?, pet_id = ?, appointment_dt = ?, status = ? WHERE id = ?',
      [user_id, pet_id, appointment_dt, status, appointmentId]
    );
    
    req.flash('success', 'Appointment updated successfully!');
    res.redirect('/admin/appointments');
    
  } catch (error) {
    console.error('❌ Error updating appointment:', error);
    req.flash('danger', 'Error updating appointment');
    res.redirect(`/admin/appointments/edit/${appointmentId}`);
  }
});

// Delete appointment route
app.post('/admin/appointments/delete/:id', needAuth(true), async (req, res) => {
  try {
    await q('DELETE FROM appointments WHERE id = ?', [req.params.id]);
    req.flash('success', 'Appointment deleted successfully!');
  } catch (error) {
    console.error('❌ Error deleting appointment:', error);
    req.flash('danger', 'Error deleting appointment');
  }
  res.redirect('/admin/appointments');
});

// Update appointment status route
app.post('/admin/appointments/status/:id', needAuth(true), async (req, res) => {
  const { status } = req.body;
  const appointmentId = req.params.id;
  
  if (!['scheduled', 'completed', 'cancelled'].includes(status)) {
    req.flash('danger', 'Invalid status');
    return res.redirect('/admin/appointments');
  }
  
  try {
    await q('UPDATE appointments SET status = ? WHERE id = ?', [status, appointmentId]);
    req.flash('success', `Appointment ${status} successfully!`);
  } catch (error) {
    console.error('❌ Error updating appointment status:', error);
    req.flash('danger', 'Error updating appointment status');
  }
  res.redirect('/admin/appointments');
});

/* ───── Boot up ───── */
app.listen(process.env.PORT || 3000, () => console.log('🐾  PetAdopt server running on 3000'));