const pool = require('../config/db');
const { getUser, roleIn } = require('../services/collab.service');

const UUID_RE = /^[0-9a-f-]{36}$/i;
const COLORS = ['#0B45B5', '#1565C0', '#2E7D32', '#D99A00', '#7A4FD6', '#AD1457', '#00838F', '#5D4037'];
const canManage = (role) => role === 'owner' || role === 'admin';

/** GET /api/teams → mis equipos */
const listTeams = async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT t.id, t.name, t.description, t.color, t.created_at, tm.role AS my_role,
              (SELECT COUNT(*)::int FROM team_members x WHERE x.team_id = t.id) AS members_count,
              (SELECT COUNT(DISTINCT s.batch_id)::int FROM document_shares s WHERE s.team_id = t.id) AS shares_count,
              (SELECT json_agg(json_build_object('name', u.name, 'email', u.email) ORDER BY m.added_at)
                 FROM (SELECT * FROM team_members WHERE team_id = t.id ORDER BY added_at LIMIT 5) m
                 LEFT JOIN users u ON u.id::text = m.user_id) AS preview
         FROM teams t JOIN team_members tm ON tm.team_id = t.id AND tm.user_id = $1
        ORDER BY t.created_at DESC`,
      [String(req.user.id)]
    );
    return res.json({ teams: r.rows });
  } catch (err) {
    console.error('ERROR LIST TEAMS:', err.message);
    return res.status(500).json({ error: 'No se pudieron cargar tus equipos' });
  }
};

/** POST /api/teams {name, description} */
const createTeam = async (req, res) => {
  const client = await pool.connect();
  try {
    const name = String(req.body?.name || '').trim().slice(0, 60);
    const description = String(req.body?.description || '').trim().slice(0, 300);
    if (name.length < 2) return res.status(400).json({ error: 'El nombre del equipo debe tener al menos 2 caracteres' });
    const count = await client.query('SELECT COUNT(*)::int AS n FROM teams WHERE owner_id = $1', [String(req.user.id)]);
    if (count.rows[0].n >= 20) return res.status(400).json({ error: 'Puedes crear hasta 20 equipos' });
    const color = COLORS[Math.floor(Math.random() * COLORS.length)];
    await client.query('BEGIN');
    const t = await client.query(
      'INSERT INTO teams (name, description, color, owner_id) VALUES ($1, $2, $3, $4) RETURNING *',
      [name, description || null, color, String(req.user.id)]
    );
    await client.query(
      "INSERT INTO team_members (team_id, user_id, role, added_by) VALUES ($1, $2, 'owner', $2)",
      [t.rows[0].id, String(req.user.id)]
    );
    await client.query('COMMIT');
    res.locals.auditDetail = { team: name };
    return res.status(201).json({ message: 'Equipo creado', team: { ...t.rows[0], my_role: 'owner', members_count: 1 } });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('ERROR CREATE TEAM:', err.message);
    return res.status(500).json({ error: 'No se pudo crear el equipo' });
  } finally {
    client.release();
  }
};

/** GET /api/teams/:id → detalle con miembros y documentos compartidos */
const getTeam = async (req, res) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Equipo no encontrado' });
    const role = await roleIn(id, req.user.id);
    if (!role) return res.status(404).json({ error: 'Equipo no encontrado' });
    const [t, m, docs] = await Promise.all([
      pool.query('SELECT * FROM teams WHERE id = $1', [id]),
      pool.query(
        `SELECT m.user_id, m.role, m.added_at, u.name, u.email, u.avatar_url
           FROM team_members m LEFT JOIN users u ON u.id::text = m.user_id
          WHERE m.team_id = $1
          ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, m.added_at`,
        [id]
      ),
      pool.query(
        `SELECT s.batch_id, MIN(s.created_at) AS created_at, MAX(s.kind) AS kind, MAX(s.subject) AS subject,
                d.title, d.file_hash, d.status AS doc_status, u.name AS sender_name, u.email AS sender_email
           FROM document_shares s
           JOIN documents d ON d.id::text = s.document_id
           LEFT JOIN users u ON u.id::text = s.sender_id
          WHERE s.team_id = $1
          GROUP BY s.batch_id, d.title, d.file_hash, d.status, u.name, u.email
          ORDER BY MIN(s.created_at) DESC LIMIT 30`,
        [id]
      ),
    ]);
    return res.json({ team: { ...t.rows[0], my_role: role }, members: m.rows, documents: docs.rows });
  } catch (err) {
    console.error('ERROR GET TEAM:', err.message);
    return res.status(500).json({ error: 'No se pudo cargar el equipo' });
  }
};

/** PATCH /api/teams/:id {name, description} */
const updateTeam = async (req, res) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Equipo no encontrado' });
    const role = await roleIn(id, req.user.id);
    if (!role) return res.status(404).json({ error: 'Equipo no encontrado' });
    if (!canManage(role)) return res.status(403).json({ error: 'Solo el dueño o un administrador puede editar el equipo' });
    const name = req.body?.name !== undefined ? String(req.body.name).trim().slice(0, 60) : null;
    if (name !== null && name.length < 2) return res.status(400).json({ error: 'El nombre es muy corto' });
    const description = req.body?.description !== undefined ? String(req.body.description).trim().slice(0, 300) : null;
    const r = await pool.query(
      'UPDATE teams SET name = COALESCE($1, name), description = COALESCE($2, description) WHERE id = $3 RETURNING *',
      [name, description, id]
    );
    return res.json({ message: 'Equipo actualizado', team: r.rows[0] });
  } catch (err) {
    return res.status(500).json({ error: 'No se pudo actualizar el equipo' });
  }
};

/** DELETE /api/teams/:id (solo el dueño) */
const deleteTeam = async (req, res) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Equipo no encontrado' });
    const role = await roleIn(id, req.user.id);
    if (!role) return res.status(404).json({ error: 'Equipo no encontrado' });
    if (role !== 'owner') return res.status(403).json({ error: 'Solo el dueño puede eliminar el equipo' });
    await pool.query('DELETE FROM teams WHERE id = $1', [id]);
    return res.json({ message: 'Equipo eliminado' });
  } catch (err) {
    return res.status(500).json({ error: 'No se pudo eliminar el equipo' });
  }
};

/** GET /api/teams/users/search?q= → personas registradas para agregar */
const searchUsers = async (req, res) => {
  try {
    const q = String(req.query.q || '').trim().toLowerCase();
    if (q.length < 3) return res.json({ users: [] });
    const r = await pool.query(
      `SELECT id, name, email FROM users
        WHERE id::text <> $2 AND (lower(email) LIKE $1 OR lower(name) LIKE $3)
        ORDER BY lower(email) = $4 DESC, name LIMIT 6`,
      [`${q}%`, String(req.user.id), `%${q}%`, q]
    );
    return res.json({ users: r.rows.map((u) => ({ id: String(u.id), name: u.name, email: u.email })) });
  } catch (err) {
    return res.status(500).json({ error: 'No se pudo buscar' });
  }
};

/** POST /api/teams/:id/members {email, role} */
const addMember = async (req, res) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Equipo no encontrado' });
    const role = await roleIn(id, req.user.id);
    if (!role) return res.status(404).json({ error: 'Equipo no encontrado' });
    if (!canManage(role)) return res.status(403).json({ error: 'Solo el dueño o un administrador puede agregar miembros' });
    const email = String(req.body?.email || '').trim().toLowerCase();
    const newRole = req.body?.role === 'admin' ? 'admin' : 'member';
    if (!email) return res.status(400).json({ error: 'Escribe el correo de la persona' });
    const u = await pool.query('SELECT id, name, email FROM users WHERE lower(email) = $1', [email]);
    if (!u.rows.length)
      return res.status(404).json({ error: 'Esa persona aún no tiene cuenta en BlockSign. Pídele que se registre o envíale el documento por correo.' });
    const count = await pool.query('SELECT COUNT(*)::int AS n FROM team_members WHERE team_id = $1', [id]);
    if (count.rows[0].n >= 50) return res.status(400).json({ error: 'Un equipo puede tener hasta 50 miembros' });
    const r = await pool.query(
      `INSERT INTO team_members (team_id, user_id, role, added_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (team_id, user_id) DO NOTHING RETURNING *`,
      [id, String(u.rows[0].id), newRole, String(req.user.id)]
    );
    if (!r.rows.length) return res.status(409).json({ error: 'Esa persona ya está en el equipo' });
    res.locals.auditDetail = { member: email, role: newRole };
    return res.status(201).json({ message: `${u.rows[0].name || email} se unió al equipo`, member: { ...r.rows[0], name: u.rows[0].name, email: u.rows[0].email } });
  } catch (err) {
    console.error('ERROR ADD MEMBER:', err.message);
    return res.status(500).json({ error: 'No se pudo agregar al miembro' });
  }
};

/** PATCH /api/teams/:id/members/:userId {role} */
const setMemberRole = async (req, res) => {
  try {
    const { id, userId } = req.params;
    const role = await roleIn(id, req.user.id);
    if (role !== 'owner') return res.status(403).json({ error: 'Solo el dueño puede cambiar roles' });
    const newRole = req.body?.role === 'admin' ? 'admin' : 'member';
    const r = await pool.query(
      "UPDATE team_members SET role = $1 WHERE team_id = $2 AND user_id = $3 AND role <> 'owner' RETURNING *",
      [newRole, id, String(userId)]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Miembro no encontrado' });
    return res.json({ message: 'Rol actualizado', member: r.rows[0] });
  } catch (err) {
    return res.status(500).json({ error: 'No se pudo cambiar el rol' });
  }
};

/** DELETE /api/teams/:id/members/:userId (quitar a alguien o salir del equipo) */
const removeMember = async (req, res) => {
  try {
    const { id, userId } = req.params;
    if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Equipo no encontrado' });
    const role = await roleIn(id, req.user.id);
    if (!role) return res.status(404).json({ error: 'Equipo no encontrado' });
    const self = String(userId) === String(req.user.id);
    if (!self && !canManage(role)) return res.status(403).json({ error: 'No puedes quitar miembros de este equipo' });
    const target = await roleIn(id, userId);
    if (!target) return res.status(404).json({ error: 'Miembro no encontrado' });
    if (target === 'owner') return res.status(400).json({ error: 'El dueño no puede salir del equipo; elimínalo si ya no lo necesitas' });
    if (target === 'admin' && role !== 'owner' && !self) return res.status(403).json({ error: 'Solo el dueño puede quitar a un administrador' });
    await pool.query('DELETE FROM team_members WHERE team_id = $1 AND user_id = $2', [id, String(userId)]);
    return res.json({ message: self ? 'Saliste del equipo' : 'Miembro retirado' });
  } catch (err) {
    return res.status(500).json({ error: 'No se pudo retirar al miembro' });
  }
};

module.exports = { listTeams, createTeam, getTeam, updateTeam, deleteTeam, searchUsers, addMember, setMemberRole, removeMember, getUser };
