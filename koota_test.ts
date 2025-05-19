import { trait, createWorld } from 'koota';

// 1. Define Traits
const TestMousePosition = trait({ x: 100, y: 100 });
const TestMouseVelocity = trait({ x: 0, y: 0 });
const TestIsThrown = trait({ value: false });

const FRICTION = 0.98; // Simple friction
const THROW_VELOCITY = { x: 50, y: -30 };

// 2. Create World
const world = createWorld();

// 3. Spawn Entity
console.log('Spawning testMouse...');
const testMouse = world.spawn(TestMousePosition, TestMouseVelocity, TestIsThrown);

console.log('Initial state:');
console.log('  Position:', testMouse.get(TestMousePosition));
console.log('  Velocity:', testMouse.get(TestMouseVelocity));
console.log('  IsThrown:', testMouse.get(TestIsThrown));

// 4. Simulate a "tap" to throw
console.log('\nSimulating tap to THROW...');
testMouse.set(TestIsThrown, { value: true });
testMouse.set(TestMouseVelocity, THROW_VELOCITY);

console.log('State after throw command:');
console.log('  Position:', testMouse.get(TestMousePosition));
console.log('  Velocity:', testMouse.get(TestMouseVelocity));
console.log('  IsThrown:', testMouse.get(TestIsThrown));

// 5. Simple "game loop"
let frameCount = 0;
const maxFrames = 200;

console.log('\nStarting simulation loop...');
const intervalId = setInterval(() => {
  frameCount++;
  if (frameCount > maxFrames) {
    console.log('\nMax frames reached. Stopping simulation.');
    clearInterval(intervalId);
    
    console.log('\nFinal state:');
    console.log('  Position:', testMouse.get(TestMousePosition));
    console.log('  Velocity:', testMouse.get(TestMouseVelocity));
    console.log('  IsThrown:', testMouse.get(TestIsThrown));
    return;
  }

  const currentPos = testMouse.get(TestMousePosition);
  const currentVel = testMouse.get(TestMouseVelocity);
  const currentThrown = testMouse.get(TestIsThrown);

  if (!currentPos || !currentVel || !currentThrown) {
    console.error('Error: Missing traits in loop!');
    clearInterval(intervalId);
    return;
  }

  let { x: posX, y: posY } = currentPos;
  let { x: velX, y: velY } = currentVel;

  if (currentThrown.value) {
    posX += velX;
    posY += velY;

    velX *= FRICTION;
    velY *= FRICTION;

    testMouse.set(TestMousePosition, { x: posX, y: posY });
    testMouse.set(TestMouseVelocity, { x: velX, y: velY });

    if (Math.abs(velX) < 0.1 && Math.abs(velY) < 0.1) {
      console.log(`[Frame ${frameCount}] Velocity near zero. Catching mouse.`);
      testMouse.set(TestIsThrown, { value: false });
      testMouse.set(TestMouseVelocity, { x: 0, y: 0 });
    }
    console.log(`[Frame ${frameCount}] THROWN: Pos=(${posX.toFixed(2)}, ${posY.toFixed(2)}), Vel=(${velX.toFixed(2)}, ${velY.toFixed(2)})`);
  } else {
    // console.log(`[Frame ${frameCount}] CAUGHT/IDLE: Pos=(${posX.toFixed(2)}, ${posY.toFixed(2)})`);
    if (frameCount > 5 && currentVel.x === THROW_VELOCITY.x ) { // Check if it's stuck after being thrown
        console.log(`[Frame ${frameCount}] Mouse is caught. Loop will stop soon if no more throws.`);
    }
  }
  if (frameCount % 50 === 0 && !currentThrown.value){
    console.log(`[Frame ${frameCount}] Mouse is caught. Position: (${posX.toFixed(2)}, ${posY.toFixed(2)})`)
  }

}, 50); // Run every 50ms

console.log('\nTest script setup complete. Simulation running for max', maxFrames, 'frames or until velocity is near zero.');
