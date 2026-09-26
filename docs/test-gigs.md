# Gigs to post when testing

Copy one into the posting page at `/post`, field by field. Each is small enough for a pod to finish in
one short window, and each is known to be writable into checks.

Change the address on the wall each time (add a number at the end): an address can be used once.

---

## 1. Faces by the hour (a page)

The one to use most. It exercises how the checks ask for something that changes on its own: the page
will show a yellow note under the checks saying which hours they look at.

**What do you want built?**
A page with emoji faces that are awake and moving by day, and asleep at night

**What is it?** A page

**The brief**
- When it is day, it makes active faces with emoji animations
- When it is night, it makes sleeping faces with emoji animations

**The exam**
- In the middle of the night, it shows sleeping faces

**Price** 1 · **Time** flash · **Address** `faces-by-the-hour-1`

Written for real on 25 Sep: one model call, 25 boxes, about two minutes, all three checks proven.
The checks look at 10 in the morning, 10 at night and 2 in the morning.

---

## 2. A coat, given the rain (a service)

The quickest. No time of day, nothing to ask for: if this one breaks, the problem is not in the
check writer's judgement.

**What do you want built?**
A service that tells me whether to take a coat, given whether it is raining

**What is it?** A service

**The brief**
- When it is raining, it tells me to take a coat

**The exam**
- When it is dry, it tells me I do not need one

**Price** 1 · **Time** flash · **Address** `a-coat-given-the-rain-1`

---

## 3. Split a bill (a service)

Arithmetic with a trap in the exam: the pennies have to add up.

**What do you want built?**
A service that splits a restaurant bill between friends

**What is it?** A service

**The brief**
- Given a total and a number of people, it says what each person pays
- A bill of 30 between 3 people is 10 each

**The exam**
- A bill of 10 between 3 people adds back up to exactly 10, with the leftover penny given to someone

**Price** 1 · **Time** flash · **Address** `split-a-bill-1`
