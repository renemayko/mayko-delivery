const users =[];
function createAccount(){
const fullName = document.getElementById("fullName").value;
const email = document.getElementById("email").value;
const phone = document.getElementById("phone").value;
const password = document.getElementById("password").value;
const accountType = document.getElementById("accountType").value;
const newUser = {
fullName: fullName,
email: email,
phone: phone,
password: password,
accountType: accountType
};
users.push(newUser);
localStorage.setItem("users"JSON.stringify(users));
alert("Account created successfully!");
window.location.href = "login.html";
}
