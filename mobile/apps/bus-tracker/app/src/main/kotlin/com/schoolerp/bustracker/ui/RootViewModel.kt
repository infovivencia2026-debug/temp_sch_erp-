package com.schoolerp.bustracker.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.schoolerp.bustracker.data.repo.TrackerRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import javax.inject.Inject

@HiltViewModel
class RootViewModel @Inject constructor(
    repository: TrackerRepository,
) : ViewModel() {

    val paired: StateFlow<Boolean> =
        repository.paired.stateIn(viewModelScope, SharingStarted.Eagerly, repository.paired.value)
}
