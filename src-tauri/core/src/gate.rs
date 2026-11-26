//! A gate through which calls pass one at a time, in the order they took a
//! number.
//!
//! The main process of the Electron build runs one piece of JavaScript at a
//! time, so two settings saves sent one after the other are written one after
//! the other, and the later change is the one that stays. Calls into this
//! kernel each run on a thread of their own, and threads do not keep the
//! order in which they were started: a save that was sent first could be
//! written last, and carry a later change back to what it was.
//!
//! A number is taken when a call arrives, before it goes to its thread. A
//! call waits at the gate until every lower number has passed it, so what
//! reaches the kernel comes in the order it was sent in.

use std::sync::{Arc, Condvar, Mutex};

/// Orders calls by the numbers they took.
#[derive(Default)]
pub struct Gate {
    /// The lowest number that has not passed yet, and the next to be taken.
    turn: Mutex<(u64, u64)>,
    ready: Condvar,
}

/// A call's place in the order. It owns its share of the gate, so it can be
/// moved to the thread the call runs on, and it is given up when the call is
/// over or given up on, so a call that never arrives does not hold the rest.
pub struct Ticket {
    gate: Arc<Gate>,
    number: u64,
}

/// A call that has passed the gate. It holds the gate until it is dropped.
pub struct Passed {
    gate: Arc<Gate>,
    number: u64,
}

impl Gate {
    pub fn new() -> Self {
        Self::default()
    }

    /// Takes the next number for a call that is about to be sent. The first
    /// number is 0, the one the gate starts at.
    pub fn ticket(self: &Arc<Self>) -> Ticket {
        let number = {
            let mut turn = self.turn.lock().expect("gate");
            let number = turn.1;
            turn.1 += 1;
            number
        };
        Ticket { gate: Arc::clone(self), number }
    }

    fn enter(&self, number: u64) {
        let mut turn = self.turn.lock().expect("gate");
        while turn.0 != number {
            turn = self.ready.wait(turn).expect("gate");
        }
    }

    /// Lets the calls behind `number` go on. The calls ahead of it have
    /// passed already, so the gate moves to the next number at least.
    fn leave(&self, number: u64) {
        let mut turn = self.turn.lock().expect("gate");
        if turn.0 <= number {
            turn.0 = number + 1;
        }
        self.ready.notify_all();
    }
}

impl Ticket {
    /// Waits for the calls ahead and passes the gate.
    pub fn wait(&self) -> Passed {
        self.gate.enter(self.number);
        Passed { gate: Arc::clone(&self.gate), number: self.number }
    }
}

/// A call that holds the gate gives it up when it is over; a call that was
/// given up before its turn is passed over.
impl Drop for Ticket {
    fn drop(&mut self) {
        self.gate.leave(self.number);
    }
}

impl Drop for Passed {
    fn drop(&mut self) {
        self.gate.leave(self.number);
    }
}

#[cfg(test)]
mod tests {
    use super::Gate;
    use std::sync::Arc;
    use std::sync::mpsc;

    #[test]
    fn calls_pass_in_the_order_they_took_a_number() {
        let gate = Arc::new(Gate::new());
        let tickets: Vec<_> = (0..8).map(|_| gate.ticket()).collect();
        let (sent, seen) = mpsc::channel();
        // The threads start in the opposite order on purpose.
        for (index, ticket) in tickets.into_iter().enumerate().rev() {
            let sent = sent.clone();
            std::thread::spawn(move || {
                let passed = ticket.wait();
                sent.send(index).unwrap();
                drop(passed);
            });
        }
        drop(sent);
        let order: Vec<_> = seen.into_iter().take(8).collect();
        assert_eq!(order, (0..8).collect::<Vec<_>>());
    }

    #[test]
    fn a_ticket_dropped_before_its_turn_does_not_hold_the_rest() {
        let gate = Arc::new(Gate::new());
        let first = gate.ticket();
        let second = gate.ticket();
        drop(first);
        let _passed = second.wait();
    }

    #[test]
    fn one_call_holds_the_gate_until_it_is_over() {
        let gate = Arc::new(Gate::new());
        let ticket = gate.ticket();
        let first = ticket.wait();
        let (sent, seen) = mpsc::channel();
        let second = gate.ticket();
        std::thread::spawn(move || {
            let passed = second.wait();
            sent.send(()).unwrap();
            drop(passed);
        });
        assert!(seen.recv_timeout(std::time::Duration::from_millis(200)).is_err());
        drop(first);
        seen.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
    }
}
