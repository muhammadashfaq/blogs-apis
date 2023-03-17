const {promisify} = require('util');
const jwt = require('jsonwebtoken');
const AppError = require('../utils/appError');
const User = require('../models/userModel');
const catchAsync = require('../utils/catchAsync');
const sendEmail = require('../utils/email');
const crypto = require('crypto');

const signToken = (id) => {
 return jwt.sign({id}, process.env.JWT_SECRET, {
  expiresIn: process.env.JWT_EXPIRES_IN,
 });
};

const createSendToken = async (user, statusCode, res) => {
 const token = signToken(user._id);
 const cookieOptions = {
  expires: new Date(
   Date.now() + process.env.JWT_COOKIE_EXPIRES_IN * 24 * 60 * 60 * 1000
  ),
  httpOnly: true,
 };
 if (process.env.NODE_ENV === 'production') cookieOptions.secure = true;

 console.log('[token]', token);
 console.log('[cookieOptions]', cookieOptions);

 res.cookie('jwt', token, cookieOptions);

 // Remove password from output
 user.password = undefined;

 res.status(statusCode).json({
  status: 'success',
  token,
  data: {
   user,
  },
 });
};

exports.signUp = catchAsync(async (req, res, next) => {
 const {name, email, password, confirmPassword} = req.body;

 if (password !== confirmPassword)
  return next(new AppError('Password and confirm Password do not match!', 400));

 const newUser = await User.create({
  name: name,
  email: email,
  password: password,
 });

 await newUser?.save();
 createSendToken(newUser, 201, res);
});

exports.login = catchAsync(async (req, res, next) => {
 const {email, password} = req.body;

 if (!email || !password) {
  return next(new AppError('Please provide email and password!', 400));
 }
 const user = await User.findOne({email}).select('+password');

 if (!user || !(await user.correctPassword(password, user.password))) {
  return next(new AppError('Incorrect email or password', 401));
 }

 createSendToken(user, 200, res);
});

exports.logout = (req, res) => {
 res.cookie('jwt', 'loggedout', {
  expires: new Date(Date.now() + 10 * 1000),
  httpOnly: true,
 });
 res.status(200).json({status: 'success', message: 'Logged out'});
};

exports.protect = catchAsync(async (req, res, next) => {
 // 1) Getting token and check of it's there
 let token;
 if (
  req.headers.authorization &&
  req.headers.authorization.startsWith('Bearer')
 ) {
  token = req.headers.authorization.split(' ')[1];
 }

 if (!token) {
  return next(
   new AppError('You are not logged in! Please log in to get access.', 401)
  );
 }

 // 2) Verification token
 const decoded = await promisify(jwt.verify)(token, process.env.JWT_SECRET);

 // 3) Check if user still exists
 const currentUser = await User.findById(decoded.id);
 if (!currentUser) {
  return next(
   new AppError('The user belonging to this token does no longer exist.', 401)
  );
 }

 // GRANT ACCESS TO PROTECTED ROUTE
 req.user = currentUser;
 res.locals.user = currentUser;
 next();
});

exports.forgotPassword = catchAsync(async (req, res, next) => {
 // 1) Get user based on POSTed email
 const user = await User.findOne({email: req.body.email});

 if (!user) {
  return next(new AppError('There is no user with email address.', 404));
 }
 // 2) Generate the random reset token
 const resetToken = user.createPasswordResetToken();
 await user.save({validateBeforeSave: false});

 // 3) Send it to user's email
 try {
  const resetURL = `${req.protocol}://${req.get(
   'host'
  )}/api/v1/users/resetPassword/${resetToken}`;
  const message = `Forgot your password? Submit a PATCH request with your new password and passwordConfirm to: ${resetURL}. \n  If you didn't forget your password, Please ignore it`;

  await sendEmail({
   email: user.email,
   subject: 'Password Reset Token (Only valid for 10 minutes)',
   message: message,
  });
  res.status(200).json({
   status: 'success',
   message: 'Token sent to email',
  });
 } catch (err) {
  user.passwordResetExpires = undefined;
  user.passwordResetToken = undefined;
  await user.save({validateBeforeSave: false});

  return next(
   new AppError('There was an error sending email.Try again later!', 500)
  );
 }
});

exports.resetPassword = catchAsync(async (req, res, next) => {
 // 1) Get user based on the token
 const hashedToken = crypto
  .createHash('sha256')
  .update(req.params.token)
  .digest('hex');

 const user = await User.findOne({
  passwordResetToken: hashedToken,
  passwordResetExpires: {$gt: Date.now()},
 });
 // 2) If token has not expired, and there is user, set the new password
 if (!user) {
  return next(new AppError('Token is invalid or has expired', 400));
 }

 user.password = req.body.password;
 user.confirmPassword = req.body.confirmPassword;
 user.passwordResetToken = undefined;
 user.passwordResetExpires = undefined;
 await user.save();
 // 3) Update changedPasswordAt property for the user
 //wrote a middleware function on schema to update it
 // 4) Log the user in, send JWT
 createSendToken(user, 200, res);
});
