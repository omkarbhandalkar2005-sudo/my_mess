const bcrypt = require('bcrypt');
bcrypt.hash('omkar@2005', 10, (err, hash) => {
    console.log(hash);
});