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
  cookie: { 
    secure: process.env.NODE_ENV === 'production',
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));
app.use(flash());

// Global middleware for locals
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.messages = req.flash();
  next();
});

/* ───── Error handling middleware ───── */
app.use((err, req, res, next) => {
  console.error('❌ Unhandled error:', err);
  if (err.code === 'LIMIT_FILE_SIZE') {
    req.flash('danger', 'File too large. Maximum size is 5MB.');
  } else if (err.message === 'Only image files are allowed!') {
    req.flash('danger', 'Only image files are allowed.');
  } else {
    req.flash('danger', 'An unexpected error occurred.');
  }
  res.redirect('back');
});

/* ───── Public pages ───── */
app.get('/', async (req, res) => {
  try {
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
      const placeholders = recentlyViewed.map(() => '?').join(',');
      const pets = await q(`SELECT * FROM pets WHERE id IN (${placeholders})`, recentlyViewed);
      recentlyViewedPets = recentlyViewed.map(id => pets.find(p => p.id == id)).filter(Boolean);
    }

    res.render('index', {
      title: 'Home',
      recentlyViewedPets
    });
  } catch (error) {
    console.error('❌ Error loading home page:', error);
    res.render('index', {
      title: 'Home',
      recentlyViewedPets: []
    });
  }
});

app.get('/pets', async (req, res) => {
  const filter = req.query.type;
  const search = req.query.search;
  const sort = req.query.sort;

  let query = 'SELECT * FROM pets';
  const values = [];
  const conditions = [];

  if (filter) {
    if (filter === 'other') {
      conditions.push('type NOT IN (?, ?)');
      values.push('Dog', 'Cat');
    } else {
      conditions.push('type = ?');
      values.push(filter.charAt(0).toUpperCase() + filter.slice(1));
    }
  }
  
  if (search && search.trim()) {
    conditions.push('(name LIKE ? OR breed LIKE ? OR description LIKE ?)');
    const searchTerm = '%' + search.trim() + '%';
    values.push(searchTerm, searchTerm, searchTerm);
  }
  
  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }

  // Add sorting
  switch (sort) {
    case 'oldest':
      query += ' ORDER BY created_at ASC';
      break;
    case 'youngest':
      query += ' ORDER BY created_at DESC';
      break;
    case 'az':
      query += ' ORDER BY name ASC';
      break;
    case 'za':
      query += ' ORDER BY name DESC';
      break;
    default:
      query += ' ORDER BY id DESC';
  }

  try {
    console.log('🔍 QUERY:', query, values);
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
    req.flash('danger', 'Error loading pets');
    res.render('pets', {
      title: 'Browse Pets',
      pets: [],
      filter: filter || null,
      search: search || '',
      sort: sort || ''
    });
  }
});

app.get('/pets/:id', async (req, res) => {
  try {
    const petId = req.params.id;
    
    if (isNaN(petId)) {
      req.flash('danger', 'Invalid pet ID');
      return res.redirect('/pets');
    }
    
    const rows = await q('SELECT * FROM pets WHERE id=?', [petId]);
    if (!rows.length) {
      req.flash('danger', 'Pet not found');
      return res.redirect('/pets');
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
    res.cookie('recentlyViewed', JSON.stringify(viewed), { 
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      httpOnly: true 
    });

    res.render('petDetails', { 
      title: rows[0].name, 
      pet: rows[0] 
    });
  } catch (err) {
    console.error('❌ Error fetching pet:', err);
    req.flash('danger', 'Error loading pet details');
    res.redirect('/pets');
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
  
  // Validate email format
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.render('register', { title: 'Register', error: 'Invalid email format' });
  }
  
  try {
    await q('INSERT INTO users(name,email,password,phone) VALUES(?,?,?,?)',
            [name, email, await bcrypt.hash(password, 10), phone || null]);
    req.flash('success', 'Registration successful! Please log in.');
    res.redirect('/login');
  } catch (error) {
    console.error('❌ Registration error:', error);
    if (error.code === 'ER_DUP_ENTRY') {
      res.render('register', { title: 'Register', error: 'Email already in use' });
    } else {
      res.render('register', { title: 'Register', error: 'Registration failed. Please try again.' });
    }
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
  const { email, password, remember } = req.body;
  
  if (!email || !password) {
    return res.render('login', { 
      title: 'Login', 
      error: 'Email and password are required', 
      rememberedEmail: email || '' 
    });
  }
  
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

    if (remember) {
      res.cookie('rememberedEmail', email, { 
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
        httpOnly: true 
      });
    } else {
      res.clearCookie('rememberedEmail');
    }

    console.log(`✅ User logged in: ${user.name} (${userType})`);
    
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
      rememberedEmail: email || '' 
    });
  }
});

app.get('/logout', (req, res) => {
  const userName = req.session.user ? req.session.user.name : 'Unknown';
  req.session.destroy((err) => {
    if (err) {
      console.error('❌ Logout error:', err);
      return res.redirect('/');
    }
    
    console.log(`👋 User logged out: ${userName}`);
    res.clearCookie('connect.sid');
    res.redirect('/');
  });
});

/* ───── Admin dashboard + pets CRUD ───── */
app.get('/dashboard', needAuth(true), async (req, res) => {
  try {
    const [{ totalPets }] = await q('SELECT COUNT(*) totalPets FROM pets');
    const [{ totalUsers }] = await q('SELECT COUNT(*) totalUsers FROM users');
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
  } catch (error) {
    console.error('❌ Dashboard error:', error);
    req.flash('danger', 'Error loading dashboard');
    res.render('dashboard', {
      title: 'Admin Dashboard',
      stats: { totalPets: 0, totalUsers: 0, totalAppointments: 0 },
      recentAppointments: []
    });
  }
});

app.get('/admin/pets', needAuth(true), async (req, res) => {
  try {
    const pets = await q('SELECT * FROM pets ORDER BY created_at DESC');
    res.render('admin-pets', { title: 'Manage Pets', pets });
  } catch (error) {
    console.error('❌ Error fetching pets:', error);
    req.flash('danger', 'Error loading pets');
    res.render('admin-pets', { title: 'Manage Pets', pets: [] });
  }
});

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
  
  if (isNaN(age) || age < 0 || age > 30) {
    return res.render('add-pet', { 
      title: 'Add Pet', 
      error: 'Age must be a number between 0 and 30.', 
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
    
    await q('INSERT INTO pets(name,type,breed,age,image,description,created_at) VALUES(?,?,?,?,?,?,NOW())',
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
  try {
    const rows = await q('SELECT * FROM pets WHERE id=?', [req.params.id]);
    if (!rows.length) {
      req.flash('danger', 'Pet not found');
      return res.redirect('/admin/pets');
    }
    res.render('edit-pets', { 
      title: 'Edit Pet', 
      pet: rows[0], 
      error: null, 
      allowedTypes: ['Dog', 'Cat', 'Others']
    });
  } catch (error) {
    console.error('❌ Error loading pet for edit:', error);
    req.flash('danger', 'Error loading pet');
    res.redirect('/admin/pets');
  }
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
  
  if (isNaN(age) || age < 0 || age > 30) {
    return res.render('edit-pets', { 
      title: 'Edit Pet', 
      pet: { id, name, type, breed, age, image, description },
      error: 'Age must be a number between 0 and 30.',
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
    
    // Check if pet has appointments
    const appointments = await q('SELECT COUNT(*) as count FROM appointments WHERE pet_id=? AND status!="cancelled"', [req.params.id]);
    if (appointments[0].count > 0) {
      req.flash('warning', 'Cannot delete pet with active appointments. Cancel appointments first.');
      return res.redirect('/admin/pets');
    }
    
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
  try {
    const userId = req.session.user.id;
    
    // Get user data
    const [user] = await q('SELECT * FROM users WHERE id=?', [userId]);
    
    if (!user) {
      req.flash('danger', 'User not found');
      return res.redirect('/logout');
    }
    
    // Get user's appointments with pet details
    const appointments = await q(
      `SELECT a.id, a.appointment_dt, a.status, a.notes, a.created_at,
              p.name as pet_name, p.type as pet_type, p.image as pet_image 
       FROM appointments a 
       JOIN pets p ON a.pet_id = p.id 
       WHERE a.user_id = ? 
       ORDER BY a.appointment_dt DESC`,
      [userId]
    );
    
    // Format appointment dates for display
    appointments.forEach(apt => {
      if (apt.appointment_dt) {
        const date = new Date(apt.appointment_dt);
        apt.formatted_date = date.toLocaleDateString('en-US', {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric'
        });
        apt.formatted_time = date.toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          hour12: true
        });
      }
    });
    
    console.log('👤 Profile loaded for user:', user.name);
    console.log('📅 Found', appointments.length, 'appointments');
    
    res.render('profile', {
      title: 'My Profile',
      user: user,
      appointments
    });
  } catch (error) {
    console.error('❌ Profile error:', error);
    req.flash('danger', 'Error loading profile');
    res.redirect('/');
  }
});

app.post('/profile/edit', needAuth(false), async (req, res) => {
  const { name, email, phone, password } = req.body;
  const userId = req.session.user.id;
  
  if (!name || !email) {
    req.flash('danger', 'Name and email are required');
    return res.redirect('/profile');
  }
  
  // Validate email format
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    req.flash('danger', 'Invalid email format');
    return res.redirect('/profile');
  }
  
  try {
    if (password && password.trim()) {
      if (password.length < 6) {
        req.flash('danger', 'Password must be at least 6 characters');
        return res.redirect('/profile');
      }
      // Update with new password
      const hashed = await bcrypt.hash(password, 10);
      await q('UPDATE users SET name=?, email=?, phone=?, password=? WHERE id=?', 
              [name, email, phone || null, hashed, userId]);
    } else {
      // Update without changing password
      await q('UPDATE users SET name=?, email=?, phone=? WHERE id=?', 
              [name, email, phone || null, userId]);
    }
    
    // Update session with new data
    req.session.user.name = name;
    req.session.user.email = email;
    req.flash('success', 'Profile updated successfully!');
  } catch (error) {
    console.error('❌ Profile update error:', error);
    if (error.code === 'ER_DUP_ENTRY') {
      req.flash('danger', 'Email already in use');
    } else {
      req.flash('danger', 'Error updating profile');
    }
  }
  res.redirect('/profile');
});

/* ───── Appointment booking ───── */
app.route('/appointments/schedule/:petId')
.get(needAuth(false), async (req, res) => {
  try {
    console.log('🐾 Appointment route accessed for pet:', req.params.petId);
    
    const petId = req.params.petId;
    
    // Add validation for petId
    if (!petId || isNaN(petId)) {
      console.log('❌ Invalid pet ID:', petId);
      req.flash('danger', 'Invalid pet ID');
      return res.redirect('/pets');
    }
    
    const [pet] = await q('SELECT * FROM pets WHERE id=?', [petId]);
    
    if (!pet) {
      console.log('🐾 Pet not found for ID:', petId);
      req.flash('danger', 'Pet not found');
      return res.redirect('/pets');
    }

    // Get all booked slots for this pet in the current booking period
    const booked = (await q(
      'SELECT appointment_dt FROM appointments WHERE pet_id=? AND status<>"cancelled" AND appointment_dt BETWEEN ? AND ?',
      [petId, '2025-07-29', '2025-08-31']
    )).map(r => r.appointment_dt.toISOString().slice(0,19).replace('T',' '));

    console.log('🐾 Pet found:', pet.name, 'with', booked.length, 'booked slots');

    res.render('appointment', { 
      title: 'Book Appointment', 
      pet, 
      bookedSlots: booked 
    });
    
  } catch (error) {
    console.error('❌ Appointment booking error:', error);
    req.flash('danger', 'Error loading appointment page');
    res.redirect('/pets');
  }
})
.post(needAuth(false), async (req, res) => {
  try {
    const petId = req.params.petId;
    
    // Ultra-detailed debugging
    console.log('📋 RAW REQUEST BODY:', JSON.stringify(req.body, null, 2));
    console.log('📋 REQUEST HEADERS:', req.headers['content-type']);
    console.log('📋 REQUEST METHOD:', req.method);
    console.log('📋 REQUEST URL:', req.url);
    
    // Check if body parser is working
    console.log('📋 Is req.body empty?', Object.keys(req.body).length === 0);
    
    const { appointmentDate, appointmentTime, notes } = req.body;
    const userId = req.session.user?.id;
    
    console.log('📅 DETAILED EXTRACTION:');
    console.log('  - req.body.appointmentDate:', req.body.appointmentDate);
    console.log('  - req.body.appointmentTime:', req.body.appointmentTime);
    console.log('  - req.body.notes:', req.body.notes);
    console.log('  - appointmentDate (destructured):', appointmentDate);
    console.log('  - appointmentTime (destructured):', appointmentTime);
    console.log('  - userId from session:', userId);
    
    // Check for different possible field names
    console.log('📋 CHECKING ALL POSSIBLE FIELD NAMES:');
    console.log('  - appointmentDate:', req.body.appointmentDate);
    console.log('  - appointment_date:', req.body.appointment_date);
    console.log('  - date:', req.body.date);
    console.log('  - appointmentTime:', req.body.appointmentTime);
    console.log('  - appointment_time:', req.body.appointment_time);
    console.log('  - time:', req.body.time);
    
    if (!userId) {
      console.log('❌ No user in session');
      req.flash('danger', 'Please log in to book an appointment');
      return res.redirect('/login');
    }
    
    // Try different field name combinations
    const finalDate = appointmentDate || req.body.appointment_date || req.body.date;
    const finalTime = appointmentTime || req.body.appointment_time || req.body.time;
    
    console.log('📅 FINAL VALUES TO USE:');
    console.log('  - finalDate:', finalDate);
    console.log('  - finalTime:', finalTime);
    
    // Validation
    if (!finalDate || !finalTime || finalDate.trim() === '' || finalTime.trim() === '') {
      console.log('❌ Validation failed - missing or empty date/time');
      console.log('  - finalDate empty?', !finalDate || finalDate.trim() === '');
      console.log('  - finalTime empty?', !finalTime || finalTime.trim() === '');
      req.flash('danger', 'Please select both date and time');
      return res.redirect(`/appointments/schedule/${petId}`);
    }
    
    // Validate date is not in the past
    const today = new Date().toISOString().split('T')[0];
    if (finalDate < today) {
      req.flash('danger', 'Cannot book appointments in the past');
      return res.redirect(`/appointments/schedule/${petId}`);
    }
    
    // Validate petId exists
    const [pet] = await q('SELECT id, name FROM pets WHERE id = ?', [petId]);
    if (!pet) {
      req.flash('danger', 'Pet not found');
      return res.redirect('/pets');
    }
    
    // Combine date and time into proper MySQL datetime format
    const appointmentDateTime = `${finalDate} ${finalTime}`;
    
    console.log('🕐 Combined appointment_dt:', appointmentDateTime);
    
    // Validate the datetime format
    const dateTimeRegex = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
    if (!dateTimeRegex.test(appointmentDateTime)) {
      console.log('❌ Invalid datetime format:', appointmentDateTime);
      req.flash('danger', 'Invalid date/time format');
      return res.redirect(`/appointments/schedule/${petId}`);
    }
    
    // Create the appointment
    const result = await q(
      'INSERT INTO appointments (user_id, pet_id, appointment_dt, status, notes, created_at) VALUES (?, ?, ?, ?, ?, NOW())',
      [userId, petId, appointmentDateTime, 'scheduled', notes || '']
    );
    
    console.log('✅ Appointment created with ID:', result.insertId);
    console.log('✅ Stored appointment_dt:', appointmentDateTime);
    
    // Format time for display
    const [hours, minutes] = finalTime.split(':');
    const hour = parseInt(hours);
    const ampm = hour >= 12 ? 'PM' : 'AM';
    const hour12 = hour % 12 || 12;
    const formattedTime = `${hour12}:${minutes.padStart(2, '0')} ${ampm}`;
    
    req.flash('success', `Appointment with ${pet.name} booked successfully for ${finalDate} at ${formattedTime}!`);
    res.redirect('/profile');
    
  } catch (error) {
    console.error('❌ Error booking appointment:', error);
    console.error('Error details:', error.message);
    req.flash('danger', 'Error booking appointment. Please try again.');
    res.redirect(`/appointments/schedule/${req.params.petId}`);
  }
});

// Available slots API endpoint
app.get('/availableSlots', needAuth(false), async (req, res) => {
  const { date, petId } = req.query;
  
  console.log('🔍 Slots requested for:', { date, petId });
  
  if (!date || !petId) {
    console.error('❌ Missing date or petId');
    return res.status(400).json({ error: 'Date and petId are required' });
  }
  
  try {
    // Return all time slots without filtering (as you requested)
    console.log('✅ Returning all available slots:', SLOTS);
    
    res.json(SLOTS);
    
  } catch (error) {
    console.error('❌ Error fetching available slots:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/appointments/cancel/:id', needAuth(false), async (req, res) => {
  try {
    const appointmentId = req.params.id;
    const userId = req.session.user.id;

    const [appointment] = await q('SELECT user_id, appointment_dt FROM appointments WHERE id = ?', [appointmentId]);
    
    if (!appointment) {
      req.flash('danger', 'Appointment not found');
      return res.redirect('/profile');
    }
    
    if (appointment.user_id !== userId) {
      req.flash('danger', 'Unauthorized access');
      return res.redirect('/profile');
    }
    
    // Check if appointment is in the past
    const now = new Date();
    const appointmentDate = new Date(appointment.appointment_dt);
    if (appointmentDate < now) {
      req.flash('danger', 'Cannot cancel past appointments');
      return res.redirect('/profile');
    }

    await q('UPDATE appointments SET status = "cancelled" WHERE id = ?', [appointmentId]);
    req.flash('success', 'Appointment cancelled successfully');
  } catch (error) {
    console.error('❌ Error cancelling appointment:', error);
    req.flash('danger', 'Error cancelling appointment');
  }
  res.redirect('/profile');
});

/* ───── Admin user management ───── */
app.get('/admin/users', needAuth(true), async (req, res) => {
  try {
    const users = await q('SELECT id, name, email, phone, created_at FROM users ORDER BY created_at DESC');
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
  
  // Validate email format
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    req.flash('danger', 'Invalid email format');
    return res.redirect('/admin/users');
  }
  
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    await q('INSERT INTO users (name, email, phone, password, created_at) VALUES (?, ?, ?, ?, NOW())',
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
  
  // Validate email format
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    req.flash('danger', 'Invalid email format');
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
    // Check if user has active appointments
    const appointments = await q('SELECT COUNT(*) as count FROM appointments WHERE user_id = ? AND status != "cancelled"', [id]);
    if (appointments[0].count > 0) {
      req.flash('warning', 'Cannot delete user with active appointments. Cancel appointments first.');
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

/* ───── Admin appointment management ───── */
app.get('/admin/appointments', needAuth(true), async (req, res) => {
  try {
    const appointments = await q(`
      SELECT a.id, a.appointment_dt, a.status, a.notes, a.created_at,
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
  
  if (!['scheduled', 'completed', 'cancelled'].includes(status)) {
    req.flash('danger', 'Invalid status');
    return res.redirect(`/admin/appointments/edit/${appointmentId}`);
  }
  
  try {
    // Check if the new time slot is available (if changed)
    const [currentAppointment] = await q('SELECT appointment_dt, pet_id FROM appointments WHERE id = ?', [appointmentId]);
    
    const currentDateTime = currentAppointment.appointment_dt.toISOString().slice(0, 19).replace('T', ' ');
    
    if (currentDateTime !== appointment_dt || currentAppointment.pet_id != pet_id) {
      // Time slot or pet changed, check if new slot is available
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

/* ───── 404 handler ───── */
app.use((req, res) => {
  res.status(404).render('404', { title: 'Page Not Found' });
});

/* ───── Boot up ───── */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('🐾  PetAdopt server running on port', PORT);
  console.log('🌐  Visit: http://localhost:' + PORT);
});