package com.schoolerp.bustracker.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.schoolerp.bustracker.data.repo.TrackerRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import javax.inject.Inject

@HiltViewModel
class RootViewModel @Inject constructor(
    repository: TrackerRepository,
) : ViewModel() {

    /** Paired, and past the card that reads the registration back to the driver. */
    val paired: StateFlow<Boolean> =
        combine(repository.paired, repository.awaitingConfirmation) { paired, confirming -> paired && !confirming }
            .stateIn(viewModelScope, SharingStarted.Eagerly, repository.paired.value && !repository.awaitingConfirmation.value)
}
